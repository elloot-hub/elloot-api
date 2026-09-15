import type { Prisma } from "@prisma/client";
import { isUserOnline } from "../../realtime/presence";

export const listingSellerSelect = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
  createdAt: true,
  lastSeenAt: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  kycStatus: true,
  reputationScore: true,
} satisfies Prisma.UserSelect;

export const listingPublicSelect = {
  id: true,
  code: true,
  title: true,
  description: true,
  priceCents: true,
  stockQuantity: true,
  unitsSold: true,
  salesCount: true,
  productType: true,
  listingModel: true,
  deliveryMode: true,
  status: true,
  createdAt: true,
  updatedAt: true,
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
    select: { id: true, url: true, sortOrder: true },
  },
  offers: {
    orderBy: { sortOrder: "asc" as const },
    select: {
      id: true,
      title: true,
      priceCents: true,
      stockQuantity: true,
      deliveryMode: true,
      sortOrder: true,
    },
  },
  seller: {
    select: listingSellerSelect,
  },
} satisfies Prisma.ListingSelect;

export type ListingPublicRow = Prisma.ListingGetPayload<{
  select: typeof listingPublicSelect;
}>;

export type SellerReviewAgg = {
  ratingCount: number;
  ratingAvg: number | null;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  positivePercent: number | null;
};

export function emptySellerReviewAgg(): SellerReviewAgg {
  return {
    ratingCount: 0,
    ratingAvg: null,
    positiveCount: 0,
    neutralCount: 0,
    negativeCount: 0,
    positivePercent: null,
  };
}

export function aggregateSellerReviews(
  ratings: Array<{ rating: number }>,
): SellerReviewAgg {
  if (ratings.length === 0) return emptySellerReviewAgg();

  let sum = 0;
  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;

  for (const row of ratings) {
    sum += row.rating;
    if (row.rating >= 4) positiveCount += 1;
    else if (row.rating === 3) neutralCount += 1;
    else negativeCount += 1;
  }

  const ratingCount = ratings.length;
  return {
    ratingCount,
    ratingAvg: Math.round((sum / ratingCount) * 10) / 10,
    positiveCount,
    neutralCount,
    negativeCount,
    positivePercent: Math.round((positiveCount / ratingCount) * 100),
  };
}

const ONLINE_MS = 5 * 60 * 1000;

export function serializeListingPublic(
  listing: ListingPublicRow,
  reviewAgg: SellerReviewAgg,
) {
  const lastSeenAt = listing.seller.lastSeenAt;
  const recent = Boolean(
    lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_MS,
  );
  const isOnline = isUserOnline(listing.seller.id) || recent;

  return {
    ...listing,
    seller: {
      id: listing.seller.id,
      name: listing.seller.name,
      username: listing.seller.username,
      avatarUrl: listing.seller.avatarUrl,
      createdAt: listing.seller.createdAt,
      lastSeenAt: listing.seller.lastSeenAt,
      isOnline,
      reputationScore: listing.seller.reputationScore,
      verifications: {
        email: Boolean(listing.seller.emailVerifiedAt),
        phone: Boolean(listing.seller.phoneVerifiedAt),
        documents: listing.seller.kycStatus === "APPROVED",
      },
      kycStatus: listing.seller.kycStatus,
      stats: reviewAgg,
    },
  };
}
