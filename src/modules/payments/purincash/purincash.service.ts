import { env } from "../../../config/env";
import { AppError } from "../../../lib/errors";
import {
  lockOrderForUpdate,
  withServiceTransaction,
  type RlsActor,
} from "../../../databases";
import { markOrderPaid } from "../payment.lifecycle";
import {
  createPurinCashCharge,
  getPurinCashCharge,
} from "./purincash.client";

const PROVIDER = "purincash";

export type PurinCashCheckout = {
  provider: typeof PROVIDER;
  providerRef: string;
  amountCents: number;
  expiresAt: string | null;
  pixCopyPaste: string;
  qrCodeImage?: string | null;
  instructions: string;
};

type StoredPix = {
  pixCopyPaste?: string;
  brCode?: string;
  qrCodeImage?: string | null;
};

function formatCheckout(
  providerRef: string,
  amountCents: number,
  expiresAt: Date | string | null | undefined,
  pixCopyPaste: string,
  qrCodeImage?: string | null,
): PurinCashCheckout {
  const expires =
    expiresAt instanceof Date
      ? expiresAt.toISOString()
      : typeof expiresAt === "string"
        ? expiresAt
        : null;

  return {
    provider: PROVIDER,
    providerRef,
    amountCents,
    expiresAt: expires,
    pixCopyPaste,
    qrCodeImage: qrCodeImage ?? null,
    instructions:
      "Pague via PIX. A confirmação é verificada automaticamente em alguns segundos.",
  };
}

function resolveExpiresIn(orderExpiresAt: Date | null) {
  if (!orderExpiresAt) return env.CHECKOUT_RESERVE_SECONDS;
  const seconds = Math.floor(
    (orderExpiresAt.getTime() - Date.now()) / 1000,
  );
  return Math.min(
    env.CHECKOUT_RESERVE_SECONDS,
    Math.max(60, seconds),
  );
}

export async function createPurinCashPayment(
  orderId: string,
  actor: RlsActor,
) {
  return withServiceTransaction(async (tx) => {
    const order = await lockOrderForUpdate(tx, orderId);
    if (!order) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    if (order.buyerId !== actor.id && actor.role !== "ADMIN") {
      throw new AppError(403, "Forbidden", "FORBIDDEN");
    }
    if (order.status !== "PENDING_PAYMENT") {
      throw new AppError(
        409,
        "Order is not pending payment",
        "INVALID_STATUS",
      );
    }

    const existing = await tx.payment.findUnique({ where: { orderId } });
    if (existing) {
      if (existing.provider !== PROVIDER) {
        throw new AppError(
          409,
          "Order already has a payment from another provider",
          "PAYMENT_PROVIDER_MISMATCH",
        );
      }

      const raw = existing.rawWebhook as StoredPix | null;
      let pixCopyPaste = raw?.pixCopyPaste ?? raw?.brCode;
      let qrCodeImage = raw?.qrCodeImage ?? null;

      if (!pixCopyPaste) {
        const charge = await getPurinCashCharge(existing.providerRef);
        pixCopyPaste = charge.pix?.brCode;
        qrCodeImage = charge.pix?.qrCodeImage ?? null;
      }

      if (!pixCopyPaste) {
        throw new AppError(
          502,
          "Could not load PurinCash PIX copy-paste",
          "PURINCASH_PIX_UNAVAILABLE",
        );
      }

      return formatCheckout(
        existing.providerRef,
        existing.amountCents,
        order.expiresAt,
        pixCopyPaste,
        qrCodeImage,
      );
    }

    const buyer = await tx.user.findUnique({
      where: { id: order.buyerId },
      select: { id: true, name: true, email: true },
    });

    const charge = await createPurinCashCharge({
      valueCents: order.amountCents,
      description: `Elloot pedido ${order.code}`,
      expiresIn: resolveExpiresIn(order.expiresAt),
      callbackUrl: env.purincashCallbackUrl,
      customer: {
        name: buyer?.name?.trim() || undefined,
        email: buyer?.email,
        externalId: buyer?.id,
      },
      metadata: JSON.stringify({ orderId: order.id, orderCode: order.code }),
    });

    const pixCopyPaste = charge.pix?.brCode;
    const qrCodeImage = charge.pix?.qrCodeImage ?? null;

    if (!pixCopyPaste) {
      throw new AppError(
        502,
        "PurinCash did not return PIX copy-paste",
        "PURINCASH_PIX_UNAVAILABLE",
      );
    }

    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: PROVIDER,
        providerRef: charge.paymentId,
        status: "PENDING",
        amountCents: order.amountCents,
        rawWebhook: {
          pixCopyPaste,
          brCode: pixCopyPaste,
          qrCodeImage,
          status: charge.status,
          expiresAt: charge.expiresAt ?? null,
          environment: charge.environment ?? null,
        },
      },
    });

    return formatCheckout(
      charge.paymentId,
      order.amountCents,
      charge.expiresAt ?? order.expiresAt,
      pixCopyPaste,
      qrCodeImage,
    );
  }, actor);
}

export async function handlePurinCashPaidWebhook(input: {
  paymentId: string;
  amountCents: number;
  event: string;
  webhookId?: string | null;
  meta?: Record<string, unknown>;
}) {
  const payment = await withServiceTransaction(async (tx) => {
    return tx.payment.findFirst({
      where: { provider: PROVIDER, providerRef: input.paymentId },
      select: { id: true, amountCents: true, status: true },
    });
  }, null);

  if (!payment) {
    throw new AppError(404, "Payment not found", "PAYMENT_NOT_FOUND");
  }

  if (payment.amountCents !== input.amountCents) {
    throw new AppError(
      409,
      "Webhook amount does not match payment",
      "PAYMENT_AMOUNT_MISMATCH",
    );
  }

  return markOrderPaid(input.paymentId, null, {
    provider: PROVIDER,
    providerRef: input.paymentId,
    auditAction: "payment.purincash.webhook.paid",
    webhookMeta: {
      event: input.event,
      webhookId: input.webhookId ?? undefined,
      amountCents: input.amountCents,
      ...input.meta,
    },
  });
}
