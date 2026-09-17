import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** Active placement window (started and not ended). */
export function activePlacementWhere(
  now = new Date(),
): Prisma.ListingPlacementWhereInput {
  return {
    status: "ACTIVE",
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}

/**
 * Map listingId → unique badge labels from active placements
 * (highest product priority first).
 */
export async function loadVisibilityBadgesByListingIds(
  tx: Tx,
  listingIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (listingIds.length === 0) return map;

  const now = new Date();
  const rows = await tx.listingPlacement.findMany({
    where: {
      listingId: { in: listingIds },
      ...activePlacementWhere(now),
      product: {
        badgeLabel: { not: null },
        active: true,
      },
    },
    select: {
      listingId: true,
      product: {
        select: { badgeLabel: true, priority: true },
      },
    },
    orderBy: [{ product: { priority: "desc" } }, { createdAt: "desc" }],
  });

  for (const row of rows) {
    const label = row.product.badgeLabel?.trim();
    if (!label) continue;
    const list = map.get(row.listingId) ?? [];
    if (!list.includes(label)) list.push(label);
    map.set(row.listingId, list);
  }

  return map;
}

export async function withVisibilityBadges<T extends { id: string }>(
  tx: Tx,
  listings: T[],
): Promise<Array<T & { visibilityBadges: string[] }>> {
  const badges = await loadVisibilityBadgesByListingIds(
    tx,
    listings.map((l) => l.id),
  );
  return listings.map((listing) => ({
    ...listing,
    visibilityBadges: badges.get(listing.id) ?? [],
  }));
}
