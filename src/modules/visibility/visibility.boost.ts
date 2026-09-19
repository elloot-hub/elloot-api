import type { Prisma } from "@prisma/client";
import { activePlacementWhere } from "./visibility.badges";

type Tx = Prisma.TransactionClient;

/**
 * Recomputes listing.visibilityBoost = max(product.priority) among
 * currently active placements. Used so catalog ORDER BY stays index-friendly.
 */
export async function syncListingVisibilityBoost(
  tx: Tx,
  listingId: string,
  now = new Date(),
) {
  const rows = await tx.listingPlacement.findMany({
    where: {
      listingId,
      ...activePlacementWhere(now),
      product: { active: true },
    },
    select: {
      product: { select: { priority: true } },
    },
  });

  const boost = rows.reduce(
    (max, row) => Math.max(max, row.product.priority),
    0,
  );

  await tx.listing.update({
    where: { id: listingId },
    data: { visibilityBoost: boost },
  });

  return boost;
}

export async function syncListingVisibilityBoostMany(
  tx: Tx,
  listingIds: string[],
  now = new Date(),
) {
  const unique = [...new Set(listingIds.filter(Boolean))];
  for (const id of unique) {
    await syncListingVisibilityBoost(tx, id, now);
  }
}
