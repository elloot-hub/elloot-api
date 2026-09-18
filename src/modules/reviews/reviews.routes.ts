import { Router } from "express";
import { z } from "zod";
import {
  withRlsTransaction,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { requireAuth } from "../../middleware/auth";
import { notifyUser } from "../conversations/notifications.notify";

export const reviewsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

const reviewSelect = {
  id: true,
  orderId: true,
  listingId: true,
  sellerId: true,
  buyerId: true,
  rating: true,
  comment: true,
  hidden: true,
  createdAt: true,
  buyer: { select: { id: true, name: true, avatarUrl: true } },
  listing: {
    select: {
      id: true,
      title: true,
      media: {
        take: 1,
        orderBy: { sortOrder: "asc" as const },
        select: { url: true },
      },
    },
  },
} as const;

const createSchema = z.object({
  orderId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});

function distributionFromRatings(ratings: number[]) {
  const stars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of ratings) {
    if (r >= 1 && r <= 5) stars[r as 1 | 2 | 3 | 4 | 5] += 1;
  }
  const count = ratings.length;
  const sum = ratings.reduce((a, b) => a + b, 0);
  const avg = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
  const positive = stars[4] + stars[5];
  const neutral = stars[3];
  const negative = stars[1] + stars[2];
  return {
    ratingCount: count,
    ratingAvg: avg,
    stars,
    positiveCount: positive,
    neutralCount: neutral,
    negativeCount: negative,
    positivePercent:
      count > 0 ? Math.round((positive / count) * 100) : null,
  };
}

reviewsRouter.get(
  "/by-listing/:listingId",
  asyncHandler(async (req, res) => {
    const listingId = routeParam(req.params.listingId, "listingId");
    const take = Math.min(Number(req.query.limit) || 20, 50);
    const cursor =
      typeof req.query.cursor === "string" ? req.query.cursor : undefined;

    const { reviews, summary } = await withRlsTransaction({}, async (tx) => {
      const listing = await tx.listing.findUnique({
        where: { id: listingId },
        select: { id: true, sellerId: true },
      });
      if (!listing) {
        throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
      }

      const allRatings = await tx.review.findMany({
        where: { listingId, hidden: false },
        select: { rating: true },
      });

      const reviews = await tx.review.findMany({
        where: {
          listingId,
          hidden: false,
          ...(cursor ? { id: { lt: cursor } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: reviewSelect,
      });

      return {
        reviews,
        summary: distributionFromRatings(allRatings.map((r) => r.rating)),
      };
    });

    res.json({
      reviews,
      summary,
      nextCursor:
        reviews.length === take
          ? (reviews[reviews.length - 1]?.id ?? null)
          : null,
    });
  }),
);

/** Reviews I wrote as buyer. */
reviewsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const reviews = await withRlsTransaction({ actor }, async (tx) =>
      tx.review.findMany({
        where: { buyerId: actor.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: reviewSelect,
      }),
    );
    res.json({ reviews });
  }),
);

/** Reviews received as seller. */
reviewsRouter.get(
  "/received",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { reviews, summary } = await withRlsTransaction({ actor }, async (tx) => {
      const all = await tx.review.findMany({
        where: { sellerId: actor.id, hidden: false },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: reviewSelect,
      });
      const ratings = await tx.review.findMany({
        where: { sellerId: actor.id, hidden: false },
        select: { rating: true },
      });
      return {
        reviews: all,
        summary: distributionFromRatings(ratings.map((r) => r.rating)),
      };
    });
    res.json({ reviews, summary });
  }),
);

reviewsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const parsed = createSchema.parse(req.body);
    const comment = parsed.comment
      ? sanitizeUserText(parsed.comment, 1000)
      : null;

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: parsed.orderId },
        select: {
          id: true,
          status: true,
          buyerId: true,
          sellerId: true,
          listingId: true,
          review: { select: { id: true } },
        },
      });
      if (!order) {
        throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
      }
      if (order.buyerId !== actor.id) {
        throw new AppError(403, "Forbidden", "FORBIDDEN");
      }
      if (order.status !== "COMPLETED") {
        throw new AppError(
          409,
          "Only completed orders can be reviewed",
          "INVALID_STATUS",
        );
      }
      if (order.review) {
        throw new AppError(409, "Order already reviewed", "REVIEW_EXISTS");
      }

      const review = await tx.review.create({
        data: {
          orderId: order.id,
          listingId: order.listingId,
          sellerId: order.sellerId,
          buyerId: order.buyerId,
          rating: parsed.rating,
          comment: comment || null,
        },
        select: reviewSelect,
      });

      return { review, sellerId: order.sellerId, rating: parsed.rating };
    });

    // Reputation bump needs service role (cannot update another user's row under RLS).
    if (result.rating >= 4) {
      await withServiceTransaction(async (tx) => {
        await tx.user.update({
          where: { id: result.sellerId },
          data: { reputationScore: { increment: 2 } },
        });
      });
    }

    void notifyUser({
      userId: result.sellerId,
      type: "REVIEW",
      title: "Nova avaliação recebida",
      body: `Você recebeu ${parsed.rating} estrela${parsed.rating === 1 ? "" : "s"}.`,
      href: `/dashboard/reviews`,
      meta: { reviewId: result.review.id },
    });

    res.status(201).json({ review: result.review });
  }),
);
