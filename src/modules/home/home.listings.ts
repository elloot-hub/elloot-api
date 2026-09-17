import type { Prisma } from "@prisma/client";

export const homeListingSelect = {
  id: true,
  code: true,
  title: true,
  priceCents: true,
  status: true,
  listingModel: true,
  deliveryMode: true,
  productType: true,
  createdAt: true,
  category: {
    select: {
      id: true,
      slug: true,
      name: true,
      imageUrl: true,
      iconUrl: true,
      slugPath: true,
      parent: {
        select: {
          id: true,
          slug: true,
          name: true,
          imageUrl: true,
          iconUrl: true,
          slugPath: true,
        },
      },
    },
  },
  media: {
    orderBy: { sortOrder: "asc" as const },
    take: 4,
    select: { url: true },
  },
  _count: {
    select: { media: true },
  },
  seller: {
    select: { id: true, name: true },
  },
} satisfies Prisma.ListingSelect;

export type HomeListingRow = Prisma.ListingGetPayload<{
  select: typeof homeListingSelect;
}>;

export function serializeHomeListing(
  row: HomeListingRow,
  visibilityBadges: string[] = [],
) {
  const { _count, ...listing } = row;
  return {
    ...listing,
    mediaCount: _count.media,
    visibilityBadges,
  };
}

export function activeListingWhere(
  extra?: Prisma.ListingWhereInput,
): Prisma.ListingWhereInput {
  return {
    status: "ACTIVE",
    category: { status: "ACTIVE" },
    ...extra,
  };
}

/** Preserve `ids` order after a findMany. */
export function orderByIds<T extends { id: string }>(
  rows: T[],
  ids: string[],
): T[] {
  const map = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => map.get(id))
    .filter((r): r is T => r !== undefined);
}
