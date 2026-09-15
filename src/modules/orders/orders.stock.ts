import type { Prisma } from "@prisma/client";
import { clearListingReservation } from "./orders.reserve";
import {
  releaseAutoStockForOrder,
  wasAutoStockConsumed,
} from "../listings/delivery-stock.service";

type Tx = Prisma.TransactionClient;

/** Restore one reserved stock unit (cancel / expire / refund). */
export async function restoreOrderStock(
  tx: Tx,
  order: { id: string; listingId: string; offerId: string | null },
) {
  if (await wasAutoStockConsumed(tx, order.id)) {
    return;
  }

  await releaseAutoStockForOrder(tx, order.id);

  if (order.offerId) {
    await tx.listingOffer.update({
      where: { id: order.offerId },
      data: { stockQuantity: { increment: 1 } },
    });
  } else {
    await tx.listing.update({
      where: { id: order.listingId },
      data: { stockQuantity: { increment: 1 } },
    });
  }
}

/**
 * Sync ACTIVE/SOLD from remaining stock.
 * Never promote REMOVED / PAUSED / DRAFT back to ACTIVE.
 */
export async function syncListingStatusAfterSale(tx: Tx, listingId: string) {
  const listing = await tx.listing.findUnique({
    where: { id: listingId },
    select: {
      status: true,
      listingModel: true,
      stockQuantity: true,
      offers: { select: { stockQuantity: true } },
    },
  });
  if (!listing) return;

  await clearListingReservation(listingId);

  if (listing.status !== "ACTIVE" && listing.status !== "SOLD") {
    return;
  }

  const hasStock =
    listing.listingModel === "DYNAMIC"
      ? listing.offers.some((o) => o.stockQuantity > 0)
      : listing.stockQuantity > 0;

  const nextStatus = hasStock ? "ACTIVE" : "SOLD";
  if (listing.status === nextStatus) return;

  await tx.listing.update({
    where: { id: listingId },
    data: { status: nextStatus },
  });
}
