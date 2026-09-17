import type { Prisma } from "@prisma/client";
import {
  activeListingWhere,
  homeListingSelect,
  orderByIds,
  serializeHomeListing,
  type HomeListingRow,
} from "./home.listings";
import { withVisibilityBadges } from "../visibility/visibility.badges";

type Tx = Prisma.TransactionClient;

type HomeSectionRow = {
  id: string;
  title: string;
  subtitle: string | null;
  source: string;
  layout: string;
  productIds: string[];
  categoryId: string | null;
  metric: string | null;
  manualListingIds: string[];
  itemLimit: number;
  columns: number;
  viewMoreHref: string | null;
  viewMoreLabel: string | null;
  sortOrder: number;
  category: { id: string; name: string; slugPath: string } | null;
};

async function fetchListingsByIds(
  tx: Tx,
  ids: string[],
  limit: number,
): Promise<HomeListingRow[]> {
  const take = Math.min(Math.max(limit, 1), 48);
  const slice = ids.slice(0, take);
  if (slice.length === 0) return [];
  const rows = await tx.listing.findMany({
    where: activeListingWhere({ id: { in: slice } }),
    select: homeListingSelect,
  });
  return orderByIds(rows, slice);
}

async function resolveCategoryListings(
  tx: Tx,
  categoryId: string,
  limit: number,
): Promise<HomeListingRow[]> {
  const match = await tx.category.findFirst({
    where: { id: categoryId, status: "ACTIVE" },
    select: { id: true, slugPath: true },
  });
  if (!match) return [];

  return tx.listing.findMany({
    where: activeListingWhere({
      category: {
        status: "ACTIVE",
        OR: [
          { id: match.id },
          { slugPath: { startsWith: `${match.slugPath}/` } },
        ],
      },
    }),
    take: Math.min(Math.max(limit, 1), 48),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: homeListingSelect,
  });
}

async function resolveMetricListings(
  tx: Tx,
  metric: string,
  limit: number,
): Promise<HomeListingRow[]> {
  const take = Math.min(Math.max(limit, 1), 48);

  if (metric === "MOST_FAVORITED") {
    return tx.listing.findMany({
      where: activeListingWhere(),
      take,
      orderBy: [
        { favorites: { _count: "desc" } },
        { salesCount: "desc" },
        { createdAt: "desc" },
      ],
      select: homeListingSelect,
    });
  }

  if (metric === "MOST_VIEWED") {
    const grouped = await tx.listingEvent.groupBy({
      by: ["listingId"],
      where: { type: "VIEW" },
      _count: { listingId: true },
      orderBy: { _count: { listingId: "desc" } },
      take,
    });
    if (grouped.length === 0) {
      // Fallback: recent when there is no view analytics yet.
      return resolveMetricListings(tx, "RECENT", take);
    }
    return fetchListingsByIds(
      tx,
      grouped.map((g) => g.listingId),
      take,
    );
  }

  if (metric === "BEST_SELLING") {
    return tx.listing.findMany({
      where: activeListingWhere(),
      take,
      orderBy: [
        { salesCount: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: homeListingSelect,
    });
  }

  // RECENT (default)
  return tx.listing.findMany({
    where: activeListingWhere(),
    take,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: homeListingSelect,
  });
}

async function resolvePlacementListings(
  tx: Tx,
  productIds: string[],
  limit: number,
): Promise<HomeListingRow[]> {
  if (productIds.length === 0) return [];
  const take = Math.min(Math.max(limit, 1), 48);
  const now = new Date();

  const placements = await tx.listingPlacement.findMany({
    where: {
      productId: { in: productIds },
      status: "ACTIVE",
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
      ],
      listing: activeListingWhere(),
    },
    orderBy: [
      { product: { priority: "desc" } },
      { startsAt: "desc" },
      { createdAt: "desc" },
    ],
    take,
    select: { listingId: true },
  });

  const ids = [...new Set(placements.map((p) => p.listingId))];
  return fetchListingsByIds(tx, ids, take);
}

async function resolveSectionListings(
  tx: Tx,
  section: HomeSectionRow,
): Promise<HomeListingRow[]> {
  switch (section.source) {
    case "CATEGORY":
      if (!section.categoryId) return [];
      return resolveCategoryListings(tx, section.categoryId, section.itemLimit);
    case "METRIC":
      return resolveMetricListings(
        tx,
        section.metric ?? "RECENT",
        section.itemLimit,
      );
    case "MANUAL":
      return fetchListingsByIds(
        tx,
        section.manualListingIds,
        section.itemLimit,
      );
    case "PLACEMENT":
      return resolvePlacementListings(
        tx,
        section.productIds,
        section.itemLimit,
      );
    default:
      return [];
  }
}

function defaultViewMoreHref(section: HomeSectionRow): string | null {
  if (section.viewMoreHref) return section.viewMoreHref;
  if (section.source === "CATEGORY" && section.category?.slugPath) {
    return `/market/${section.category.slugPath}`;
  }
  if (section.source === "METRIC") {
    if (section.metric === "BEST_SELLING") {
      return "/market?sort=best_sellers";
    }
    return "/market";
  }
  return "/market";
}

export async function resolveHomeSections(tx: Tx) {
  const sections = await tx.homeSection.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      category: { select: { id: true, name: true, slugPath: true } },
    },
  });

  const resolved = await Promise.all(
    sections.map(async (section) => {
      const listings = await resolveSectionListings(tx, section);
      const withBadges = await withVisibilityBadges(tx, listings);
      return {
        id: section.id,
        title: section.title,
        subtitle: section.subtitle,
        source: section.source,
        layout: section.layout,
        columns: section.columns,
        viewMoreHref: defaultViewMoreHref(section),
        viewMoreLabel: section.viewMoreLabel ?? "Ver mais",
        category: section.category
          ? {
              id: section.category.id,
              name: section.category.name,
              slugPath: section.category.slugPath,
            }
          : null,
        metric: section.metric,
        listings: withBadges.map(({ visibilityBadges, ...row }) =>
          serializeHomeListing(row, visibilityBadges),
        ),
      };
    }),
  );

  // Hide empty sections (e.g. PLACEMENT with no purchases yet).
  return resolved.filter((s) => s.listings.length > 0);
}
