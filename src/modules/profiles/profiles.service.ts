import type { Prisma } from "@prisma/client";
import {
  aggregateSellerReviews,
  listingPublicSelect,
  serializeListingPublic,
} from "../listings/listings.shared";
import { ensureUserUsername } from "../../lib/username";
import { isUserOnline } from "../../realtime/presence";

type Tx = Prisma.TransactionClient;

const ONLINE_MS = 5 * 60 * 1000;

function formatAvgDelivery(avgMinutes: number | null): string {
  if (avgMinutes == null || !Number.isFinite(avgMinutes)) return "—";
  if (avgMinutes < 1) return "menos de 1 minuto";
  const rounded = Math.max(1, Math.round(avgMinutes));
  return rounded === 1 ? "1 minuto" : `${rounded} minutos`;
}

export async function getPublicProfile(tx: Tx, idOrUsername: string) {
  const key = idOrUsername.trim();
  if (!key) return null;

  let seller = await tx.user.findFirst({
    where: {
      OR: [
        { username: key.toLowerCase() },
        { id: key },
      ],
    },
    select: {
      id: true,
      email: true,
      name: true,
      username: true,
      bio: true,
      avatarUrl: true,
      createdAt: true,
      lastSeenAt: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      kycStatus: true,
      reputationScore: true,
    },
  });

  if (!seller) return null;

  const username = await ensureUserUsername(tx, seller);
  seller = { ...seller, username };

  const sellerId = seller.id;

  const [
    listings,
    ratings,
    recentReviews,
    completedCount,
    deliveredCount,
    refundedCount,
    deliverySamples,
    reviewsLast24h,
  ] = await Promise.all([
    tx.listing.findMany({
      where: { sellerId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: listingPublicSelect,
    }),
    tx.review.findMany({
      where: { sellerId, hidden: false },
      select: { rating: true },
    }),
    tx.review.findMany({
      where: { sellerId, hidden: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 40,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        buyer: { select: { id: true, name: true, username: true, avatarUrl: true } },
        listing: {
          select: {
            id: true,
            title: true,
            productType: true,
          },
        },
        order: { select: { code: true } },
      },
    }),
    tx.order.count({
      where: { sellerId, status: "COMPLETED" },
    }),
    tx.order.count({
      where: {
        sellerId,
        deliveredAt: { not: null },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
    }),
    tx.order.count({
      where: { sellerId, status: "REFUNDED" },
    }),
    tx.order.findMany({
      where: {
        sellerId,
        paidAt: { not: null },
        deliveredAt: { not: null },
        status: { in: ["DELIVERED", "COMPLETED"] },
      },
      select: { paidAt: true, deliveredAt: true },
      take: 200,
      orderBy: { deliveredAt: "desc" },
    }),
    tx.review.count({
      where: {
        sellerId,
        hidden: false,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const reviewAgg = aggregateSellerReviews(ratings);
  const lastSeenAt = seller.lastSeenAt;
  const recent = Boolean(
    lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_MS,
  );
  const isOnline = isUserOnline(seller.id) || recent;

  let avgDeliveryMinutes: number | null = null;
  if (deliverySamples.length > 0) {
    let totalMs = 0;
    let n = 0;
    for (const row of deliverySamples) {
      if (!row.paidAt || !row.deliveredAt) continue;
      const ms = row.deliveredAt.getTime() - row.paidAt.getTime();
      if (ms >= 0) {
        totalMs += ms;
        n += 1;
      }
    }
    if (n > 0) avgDeliveryMinutes = totalMs / n / 60_000;
  }

  const totalSales = completedCount;
  const undeliveredCount = refundedCount;
  const deliveryBase = deliveredCount + undeliveredCount;
  const deliveryRatePercent =
    deliveryBase > 0
      ? Number(((deliveredCount / deliveryBase) * 100).toFixed(1))
      : totalSales > 0
        ? 100
        : 0;

  const reviewsPerHour =
    reviewsLast24h > 0 ? Number((reviewsLast24h / 24).toFixed(1)) : 0;

  return {
    seller: {
      id: seller.id,
      username,
      name: seller.name,
      bio: seller.bio,
      avatarUrl: seller.avatarUrl,
      createdAt: seller.createdAt.toISOString(),
      lastSeenAt: seller.lastSeenAt?.toISOString() ?? null,
      isOnline,
      reputationScore: seller.reputationScore,
      kycStatus: seller.kycStatus,
      verifications: {
        email: Boolean(seller.emailVerifiedAt),
        phone: Boolean(seller.phoneVerifiedAt),
        documents: seller.kycStatus === "APPROVED",
      },
      stats: reviewAgg,
    },
    stats: {
      totalSales,
      deliveredCount,
      undeliveredCount,
      deliveryRatePercent,
      avgDeliveryMinutes,
      avgDeliveryTime: formatAvgDelivery(avgDeliveryMinutes),
      reviewsPerHour,
      reviewsLast24h,
      positivePercent: reviewAgg.positivePercent ?? 0,
      positiveCount: reviewAgg.positiveCount,
      neutralCount: reviewAgg.neutralCount,
      negativeCount: reviewAgg.negativeCount,
    },
    listings: listings.map((listing) => {
      const serialized = serializeListingPublic(listing, reviewAgg);
      return {
        id: serialized.id,
        code: serialized.code,
        title: serialized.title,
        priceCents: serialized.priceCents,
        status: serialized.status,
        listingModel: serialized.listingModel,
        deliveryMode: serialized.deliveryMode,
        productType: serialized.productType,
        createdAt:
          serialized.createdAt instanceof Date
            ? serialized.createdAt.toISOString()
            : String(serialized.createdAt),
        category: serialized.category,
        media: serialized.media.map((m) => ({ url: m.url })),
        mediaCount: listing.media.length,
        seller: {
          id: seller.id,
          username,
          name: seller.name,
          avatarUrl: seller.avatarUrl,
        },
      };
    }),
    reviews: recentReviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt.toISOString(),
      buyerName: review.buyer.name,
      buyerUsername: review.buyer.username,
      buyerAvatar: review.buyer.avatarUrl,
      productTitle: review.listing.title,
      productType: review.listing.productType ?? "OUTROS",
      orderCode: review.order.code,
    })),
  };
}
