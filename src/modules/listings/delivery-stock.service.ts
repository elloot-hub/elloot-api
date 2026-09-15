import type { DeliveryMode, Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { sanitizeUserText } from "../../lib/sanitize";

type Tx = Prisma.TransactionClient;

const MAX_AUTO_STOCK_LINES = 10_000;
const MAX_LINE_LENGTH = 2000;

export function normalizeAutoStockLines(lines: string[] | undefined): string[] {
  if (!lines?.length) return [];
  const out: string[] = [];
  for (const raw of lines) {
    const line = sanitizeUserText(raw, MAX_LINE_LENGTH);
    if (line) out.push(line);
    if (out.length >= MAX_AUTO_STOCK_LINES) break;
  }
  return out;
}

export async function countAvailableStock(
  tx: Tx,
  target: { listingId: string; offerId?: string | null },
) {
  if (target.offerId) {
    return tx.deliveryStockItem.count({
      where: { offerId: target.offerId, status: "AVAILABLE" },
    });
  }
  return tx.deliveryStockItem.count({
    where: { listingId: target.listingId, offerId: null, status: "AVAILABLE" },
  });
}

/** Replace AVAILABLE lines for a simple listing (keeps RESERVED/CONSUMED). */
export async function syncListingAutoStock(
  tx: Tx,
  listingId: string,
  lines: string[],
) {
  const normalized = normalizeAutoStockLines(lines);
  await tx.deliveryStockItem.deleteMany({
    where: { listingId, offerId: null, status: "AVAILABLE" },
  });
  if (normalized.length) {
    await tx.deliveryStockItem.createMany({
      data: normalized.map((content, sortOrder) => ({
        listingId,
        content,
        sortOrder,
        status: "AVAILABLE",
      })),
    });
  }
  const available = await countAvailableStock(tx, { listingId });
  await tx.listing.update({
    where: { id: listingId },
    data: { stockQuantity: available },
  });
  return available;
}

/** Replace AVAILABLE lines for a dynamic offer. */
export async function syncOfferAutoStock(
  tx: Tx,
  offerId: string,
  lines: string[],
) {
  const normalized = normalizeAutoStockLines(lines);
  await tx.deliveryStockItem.deleteMany({
    where: { offerId, status: "AVAILABLE" },
  });
  if (normalized.length) {
    await tx.deliveryStockItem.createMany({
      data: normalized.map((content, sortOrder) => ({
        offerId,
        content,
        sortOrder,
        status: "AVAILABLE",
      })),
    });
  }
  const available = await tx.deliveryStockItem.count({
    where: { offerId, status: "AVAILABLE" },
  });
  await tx.listingOffer.update({
    where: { id: offerId },
    data: { stockQuantity: available },
  });
  return available;
}

export async function loadOwnerAutoStockLines(
  tx: Tx,
  target: { listingId?: string; offerId?: string },
) {
  const items = await loadOwnerAutoStockItems(tx, target);
  return items.map((r) => r.content);
}

export async function loadOwnerAutoStockItems(
  tx: Tx,
  target: { listingId?: string; offerId?: string },
) {
  if (target.offerId) {
    return tx.deliveryStockItem.findMany({
      where: { offerId: target.offerId, status: "AVAILABLE" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, content: true },
    });
  }
  if (!target.listingId) return [];
  return tx.deliveryStockItem.findMany({
    where: { listingId: target.listingId, offerId: null, status: "AVAILABLE" },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, content: true },
  });
}

/** Append new AVAILABLE lines without wiping existing ones. */
export async function appendAutoStockLines(
  tx: Tx,
  target: { listingId: string; offerId?: string | null },
  lines: string[],
) {
  const normalized = normalizeAutoStockLines(lines);
  if (!normalized.length) return 0;

  const existingMax = await tx.deliveryStockItem.aggregate({
    where: target.offerId
      ? { offerId: target.offerId }
      : { listingId: target.listingId, offerId: null },
    _max: { sortOrder: true },
  });
  let sortOrder = (existingMax._max.sortOrder ?? -1) + 1;

  await tx.deliveryStockItem.createMany({
    data: normalized.map((content) => ({
      listingId: target.offerId ? null : target.listingId,
      offerId: target.offerId ?? null,
      content,
      sortOrder: sortOrder++,
      status: "AVAILABLE" as const,
    })),
  });

  await reconcileAutoStockQuantity(tx, target);
  return normalized.length;
}

/** Soft-delete AVAILABLE lines by id (seller-owned). */
export async function removeAutoStockItems(
  tx: Tx,
  target: { listingId: string; offerId?: string | null },
  itemIds: string[],
) {
  if (!itemIds.length) return 0;
  const result = await tx.deliveryStockItem.deleteMany({
    where: {
      id: { in: itemIds },
      status: "AVAILABLE",
      ...(target.offerId
        ? { offerId: target.offerId }
        : { listingId: target.listingId, offerId: null }),
    },
  });
  await reconcileAutoStockQuantity(tx, target);
  return result.count;
}

export async function resolveOrderDeliveryMode(
  tx: Tx,
  order: { listingId: string; offerId: string | null },
): Promise<DeliveryMode> {
  if (order.offerId) {
    const offer = await tx.listingOffer.findUnique({
      where: { id: order.offerId },
      select: { deliveryMode: true },
    });
    if (offer) return offer.deliveryMode;
  }
  const listing = await tx.listing.findUnique({
    where: { id: order.listingId },
    select: { deliveryMode: true },
  });
  return listing?.deliveryMode ?? "MANUAL";
}

/** Tie one AVAILABLE stock line to a pending order at checkout. */
export async function reserveAutoStockForOrder(
  tx: Tx,
  order: { id: string; listingId: string; offerId: string | null },
  deliveryMode: DeliveryMode,
) {
  if (deliveryMode !== "AUTO") return null;

  const rows = order.offerId
    ? await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM delivery_stock_items
        WHERE "offerId" = ${order.offerId} AND status = 'AVAILABLE'::"DeliveryStockStatus"
        ORDER BY "sortOrder" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE
      `
    : await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM delivery_stock_items
        WHERE "listingId" = ${order.listingId}
          AND "offerId" IS NULL
          AND status = 'AVAILABLE'::"DeliveryStockStatus"
        ORDER BY "sortOrder" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE
      `;

  const item = rows[0];
  if (!item) {
    throw new AppError(
      409,
      "Este anúncio não tem chaves de entrega automática disponíveis. O vendedor precisa recarregar o estoque automático.",
      "AUTO_STOCK_UNAVAILABLE",
    );
  }

  await tx.deliveryStockItem.update({
    where: { id: item.id },
    data: { status: "RESERVED", orderId: order.id },
  });

  return item.id;
}

/** On payment: mark stock consumed and return delivery text. */
export async function consumeAutoStockForOrder(
  tx: Tx,
  orderId: string,
): Promise<string | null> {
  const item = await tx.deliveryStockItem.findFirst({
    where: { orderId, status: "RESERVED" },
    select: { id: true, content: true },
  });
  if (!item) return null;

  await tx.deliveryStockItem.update({
    where: { id: item.id },
    data: { status: "CONSUMED" },
  });

  return item.content;
}

/** Restore a reserved (unpaid/cancelled) unit back to inventory. */
export async function releaseAutoStockForOrder(tx: Tx, orderId: string) {
  const item = await tx.deliveryStockItem.findFirst({
    where: { orderId, status: "RESERVED" },
    select: { id: true, listingId: true, offerId: true },
  });
  if (!item) return false;

  await tx.deliveryStockItem.update({
    where: { id: item.id },
    data: { status: "AVAILABLE", orderId: null },
  });
  return true;
}

export async function wasAutoStockConsumed(tx: Tx, orderId: string) {
  const item = await tx.deliveryStockItem.findFirst({
    where: { orderId, status: "CONSUMED" },
    select: { id: true },
  });
  return Boolean(item);
}

/**
 * Keep listing/offer.stockQuantity aligned with AVAILABLE auto keys.
 * Call under service or owner RLS.
 */
export async function reconcileAutoStockQuantity(
  tx: Tx,
  target: { listingId: string; offerId?: string | null },
) {
  if (target.offerId) {
    const available = await countAvailableStock(tx, {
      listingId: target.listingId,
      offerId: target.offerId,
    });
    await tx.listingOffer.update({
      where: { id: target.offerId },
      data: { stockQuantity: available },
    });
    return available;
  }

  const available = await countAvailableStock(tx, {
    listingId: target.listingId,
  });
  await tx.listing.update({
    where: { id: target.listingId },
    data: { stockQuantity: available },
  });
  return available;
}
