import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import {
  creditWallet,
  lockOrderForUpdate,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { calcFeeCents } from "./orders.fees";
import {
  restoreOrderStock,
  syncListingStatusAfterSale,
} from "./orders.stock";

type Tx = Parameters<Parameters<typeof withServiceTransaction>[0]>[0];

export async function completeOrderTx(
  tx: Tx,
  orderId: string,
  options?: { allowDisputed?: boolean },
) {
  const order = await lockOrderForUpdate(tx, orderId);
  if (!order) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  if (order.status === "COMPLETED") {
    return tx.order.findUniqueOrThrow({ where: { id: order.id } });
  }

  const okStatuses = options?.allowDisputed
    ? ["PAID", "DELIVERED", "DISPUTED"]
    : ["PAID", "DELIVERED"];
  if (!okStatuses.includes(order.status)) {
    throw new AppError(409, "Order cannot be completed", "INVALID_STATUS");
  }

  const existingCredit = await tx.walletLedger.findFirst({
    where: { orderId: order.id, type: "CREDIT_SALE" },
  });

  const credit = order.amountCents - order.feeCents;
  if (!existingCredit) {
    await creditWallet(tx, {
      userId: order.sellerId,
      orderId: order.id,
      type: "CREDIT_SALE",
      amountCents: credit,
      description: `Venda liberada — pedido ${order.code}`,
    });
  }

  await tx.escrowHold.updateMany({
    where: { orderId: order.id, releasedAt: null },
    data: { releasedAt: new Date() },
  });

  // Stock already decremented at checkout; mark SOLD only when depleted.
  await syncListingStatusAfterSale(tx, order.listingId);

  await tx.listing.update({
    where: { id: order.listingId },
    data: {
      unitsSold: { increment: 1 },
      salesCount: { increment: 1 },
    },
  });

  await tx.user.update({
    where: { id: order.sellerId },
    data: { reputationScore: { increment: 1 } },
  });

  return tx.order.update({
    where: { id: order.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

/** Full refund to buyer wallet; restore stock and reopen listing if needed. */
export async function refundOrderTx(tx: Tx, orderId: string) {
  const order = await lockOrderForUpdate(tx, orderId);
  if (!order) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  if (order.status === "REFUNDED") {
    return tx.order.findUniqueOrThrow({ where: { id: order.id } });
  }
  if (!["PAID", "DELIVERED", "DISPUTED"].includes(order.status)) {
    throw new AppError(409, "Order cannot be refunded", "INVALID_STATUS");
  }

  const existingRefund = await tx.walletLedger.findFirst({
    where: { orderId: order.id, type: "REFUND" },
  });
  if (!existingRefund) {
    await creditWallet(tx, {
      userId: order.buyerId,
      orderId: order.id,
      type: "REFUND",
      amountCents: order.amountCents,
      description: `Reembolso — pedido ${order.code}`,
    });
  }

  await tx.escrowHold.updateMany({
    where: { orderId: order.id, releasedAt: null },
    data: { releasedAt: new Date() },
  });

  await tx.payment.updateMany({
    where: { orderId: order.id },
    data: { status: "REFUNDED" },
  });

  await restoreOrderStock(tx, order);
  await syncListingStatusAfterSale(tx, order.listingId);

  return tx.order.update({
    where: { id: order.id },
    data: { status: "REFUNDED", completedAt: new Date() },
  });
}

/** Partial: seller gets net of fee on their share; buyer gets the remainder. */
export async function settlePartialOrderTx(
  tx: Tx,
  orderId: string,
  sellerAmountCents: number,
) {
  const order = await lockOrderForUpdate(tx, orderId);
  if (!order) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  if (order.status !== "DISPUTED") {
    throw new AppError(409, "Partial settle requires disputed order", "INVALID_STATUS");
  }

  const buyerRefund = order.amountCents - sellerAmountCents;
  const sellerFee = calcFeeCents(sellerAmountCents);
  const sellerNet = sellerAmountCents - sellerFee;

  const existingSale = await tx.walletLedger.findFirst({
    where: { orderId: order.id, type: "CREDIT_SALE" },
  });
  if (!existingSale && sellerNet > 0) {
    await creditWallet(tx, {
      userId: order.sellerId,
      orderId: order.id,
      type: "CREDIT_SALE",
      amountCents: sellerNet,
      description: `Liberação parcial — pedido ${order.code}`,
    });
  }

  const existingRefund = await tx.walletLedger.findFirst({
    where: { orderId: order.id, type: "REFUND" },
  });
  if (!existingRefund && buyerRefund > 0) {
    await creditWallet(tx, {
      userId: order.buyerId,
      orderId: order.id,
      type: "REFUND",
      amountCents: buyerRefund,
      description: `Reembolso parcial — pedido ${order.code}`,
    });
  }

  await tx.escrowHold.updateMany({
    where: { orderId: order.id, releasedAt: null },
    data: { releasedAt: new Date() },
  });

  // Unit stays sold (stock already decremented at checkout).
  await syncListingStatusAfterSale(tx, order.listingId);

  return tx.order.update({
    where: { id: order.id },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

export async function cancelOrderByBuyer(
  orderId: string,
  buyerId: string,
  actor: RlsActor,
) {
  if (actor.id !== buyerId && actor.role !== "ADMIN") {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  return withServiceTransaction(async (tx) => {
    const order = await lockOrderForUpdate(tx, orderId);
    if (!order) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    if (order.buyerId !== buyerId && actor.role !== "ADMIN") {
      throw new AppError(403, "Forbidden", "FORBIDDEN");
    }
    if (order.status !== "PENDING_PAYMENT") {
      throw new AppError(409, "Only pending orders can be cancelled", "INVALID_STATUS");
    }

    await tx.payment.updateMany({
      where: { orderId: order.id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    await restoreOrderStock(tx, order);
    await syncListingStatusAfterSale(tx, order.listingId);

    return tx.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED" },
    });
  }, actor);
}

export async function expirePendingOrders() {
  return withServiceTransaction(async (tx) => {
    const now = new Date();
    const due = await tx.$queryRaw<
      { id: string; listingId: string; offerId: string | null }[]
    >`
      SELECT id, "listingId", "offerId"
      FROM orders
      WHERE status = 'PENDING_PAYMENT'
        AND "expiresAt" IS NOT NULL
        AND "expiresAt" < ${now}
      FOR UPDATE SKIP LOCKED
      LIMIT 100
    `;

    let expired = 0;
    for (const row of due) {
      await tx.payment.updateMany({
        where: { orderId: row.id, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
      await restoreOrderStock(tx, row);
      await syncListingStatusAfterSale(tx, row.listingId);
      await tx.order.update({
        where: { id: row.id },
        data: { status: "EXPIRED" },
      });
      expired += 1;
    }

    return { expired };
  });
}

export async function autoReleaseDueEscrows() {
  return withServiceTransaction(async (tx) => {
    const now = new Date();
    const due = await tx.$queryRaw<{ orderId: string }[]>`
      SELECT eh."orderId"
      FROM escrow_holds eh
      JOIN orders o ON o.id = eh."orderId"
      WHERE eh."releasedAt" IS NULL
        AND eh."releaseAt" <= ${now}
        AND o.status IN ('PAID', 'DELIVERED')
      ORDER BY eh."releaseAt" ASC
      LIMIT 50
      FOR UPDATE OF eh SKIP LOCKED
    `;

    let released = 0;
    for (const row of due) {
      await completeOrderTx(tx, row.orderId);
      released += 1;
    }

    return { released, escrowHours: env.ESCROW_AUTO_RELEASE_HOURS };
  });
}
