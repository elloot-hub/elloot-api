import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../../../config/env";
import { AppError } from "../../../lib/errors";
import { handlePurinCashPaidWebhook } from "./purincash.service";

const paidEventSchema = z.object({
  event: z.string().min(1),
  paymentId: z.string().min(1),
  amountCents: z.number().int().positive(),
  status: z.string().optional(),
  paidAt: z.string().optional(),
  sandbox: z.boolean().optional(),
  endToEndId: z.string().optional(),
  txId: z.string().optional(),
});

function rawBodyBuffer(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  throw new AppError(
    400,
    "Raw webhook body required for signature validation",
    "WEBHOOK_RAW_BODY_REQUIRED",
  );
}

export function verifyPurinCashSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
) {
  const secret = env.PURINCASH_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new AppError(
      503,
      "PurinCash webhook is disabled",
      "WEBHOOK_DISABLED",
    );
  }

  const provided = (signatureHeader ?? "").trim();
  if (!provided) {
    throw new AppError(401, "Missing webhook signature", "WEBHOOK_UNAUTHORIZED");
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(401, "Invalid webhook signature", "WEBHOOK_UNAUTHORIZED");
  }
}

/**
 * POST /api/payments/webhooks/purincash
 * Body must be raw Buffer (express.raw) for HMAC verification.
 */
export async function purincashWebhookHandler(req: Request, res: Response) {
  const raw = rawBodyBuffer(req);
  const signature =
    typeof req.headers["x-webhook-signature"] === "string"
      ? req.headers["x-webhook-signature"]
      : undefined;

  verifyPurinCashSignature(raw, signature);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AppError(400, "Invalid JSON body", "WEBHOOK_BAD_JSON");
  }

  const body = paidEventSchema.parse(parsed);
  const webhookId =
    typeof req.headers["x-webhook-id"] === "string"
      ? req.headers["x-webhook-id"]
      : null;

  const isPaidEvent =
    body.event === "charge.paid" || body.event === "payment.paid";

  if (!isPaidEvent) {
    res.json({ received: true, ignored: true, event: body.event });
    return;
  }

  if (body.status && body.status !== "paid") {
    res.json({ received: true, ignored: true, status: body.status });
    return;
  }

  try {
    const result = await handlePurinCashPaidWebhook({
      paymentId: body.paymentId,
      amountCents: body.amountCents,
      event: body.event,
      webhookId,
      meta: {
        paidAt: body.paidAt,
        sandbox: body.sandbox,
        endToEndId: body.endToEndId,
        txId: body.txId,
      },
    });
    res.json({ received: true, ...result });
  } catch (err) {
    // Amount mismatch will not self-heal — acknowledge to stop retries.
    if (err instanceof AppError && err.code === "PAYMENT_AMOUNT_MISMATCH") {
      res.status(200).json({
        received: true,
        ignored: true,
        error: "PAYMENT_AMOUNT_MISMATCH",
      });
      return;
    }
    throw err;
  }
}
