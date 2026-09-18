import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";

export const adminReviewsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

function partyName(user: { name: string | null; email?: string }) {
  return user.name?.trim() || user.email?.trim() || "Usuário";
}

function statusOf(hidden: boolean, rating: number): "PUBLISHED" | "PENDING" | "HIDDEN" {
  if (hidden) return "HIDDEN";
  if (rating <= 2) return "PENDING";
  return "PUBLISHED";
}

const reviewSelect = {
  id: true,
  orderId: true,
  rating: true,
  comment: true,
  hidden: true,
  createdAt: true,
  buyer: { select: { id: true, name: true, email: true, avatarUrl: true } },
  seller: { select: { id: true, name: true, email: true, avatarUrl: true } },
  listing: { select: { id: true, title: true } },
} as const;

function serializeReview(
  row: Prisma.ReviewGetPayload<{ select: typeof reviewSelect }>,
) {
  return {
    id: row.id,
    rating: row.rating as 1 | 2 | 3 | 4 | 5,
    comment: row.comment ?? "",
    status: statusOf(row.hidden, row.rating),
    createdAt: row.createdAt.toISOString(),
    buyer: {
      id: row.buyer.id,
      name: partyName(row.buyer),
      avatarUrl: row.buyer.avatarUrl,
    },
    seller: {
      id: row.seller.id,
      name: partyName(row.seller),
      avatarUrl: row.seller.avatarUrl,
    },
    listing: row.listing,
    orderId: row.orderId,
  };
}

adminReviewsRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [all, hidden, negativesVisible] = await Promise.all([
        tx.review.findMany({ select: { rating: true, hidden: true } }),
        tx.review.count({ where: { hidden: true } }),
        tx.review.count({ where: { hidden: false, rating: { lte: 2 } } }),
      ]);

      const visible = all.filter((r) => !r.hidden);
      const total = all.length;
      const sum = visible.reduce((acc, r) => acc + r.rating, 0);
      const negatives = visible.filter((r) => r.rating <= 2).length;

      return {
        averageRating:
          visible.length > 0
            ? Math.round((sum / visible.length) * 10) / 10
            : 0,
        total,
        negativeSharePct:
          visible.length > 0
            ? Math.round((negatives / visible.length) * 1000) / 10
            : 0,
        pendingModeration: negativesVisible,
        hidden,
      };
    });

    res.json({ stats });
  }),
);

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  ratings: z.string().optional(),
  statuses: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});

adminReviewsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = listQuerySchema.parse(req.query);
    const q = query.q?.trim();

    const ratings = query.ratings
      ? query.ratings
          .split(",")
          .map((v) => Number(v))
          .filter((n) => n >= 1 && n <= 5)
      : [];

    const statuses = query.statuses
      ? query.statuses
          .split(",")
          .map((v) => v.trim().toUpperCase())
          .filter((v) => ["PUBLISHED", "PENDING", "HIDDEN"].includes(v))
      : [];

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.review.findMany({
        where: {
          ...(ratings.length ? { rating: { in: ratings } } : {}),
          ...(from || to
            ? {
                createdAt: {
                  ...(from ? { gte: from } : {}),
                  ...(to ? { lte: to } : {}),
                },
              }
            : {}),
          ...(q
            ? {
                OR: [
                  { comment: { contains: q, mode: "insensitive" } },
                  { listing: { title: { contains: q, mode: "insensitive" } } },
                  { buyer: { name: { contains: q, mode: "insensitive" } } },
                  { buyer: { email: { contains: q, mode: "insensitive" } } },
                  { seller: { name: { contains: q, mode: "insensitive" } } },
                  { seller: { email: { contains: q, mode: "insensitive" } } },
                ],
              }
            : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: Math.min(200, query.take * 3 + 1),
        select: reviewSelect,
      });

      let items = rows.map(serializeReview);
      if (statuses.length > 0) {
        items = items.filter((item) => statuses.includes(item.status));
      }

      const hasMore = items.length > query.take;
      const page = hasMore ? items.slice(0, query.take) : items;

      return {
        items: page,
        nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

const statusSchema = z.object({
  status: z.enum(["PUBLISHED", "HIDDEN"]),
});

adminReviewsRouter.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = routeParam(req.params.id);
    const body = statusSchema.parse(req.body);
    const hidden = body.status === "HIDDEN";

    const updated = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.review.findUnique({
        where: { id },
        select: reviewSelect,
      });
      if (!existing) {
        throw new AppError(404, "Review not found", "REVIEW_NOT_FOUND");
      }

      const row = await tx.review.update({
        where: { id },
        data: { hidden },
        select: reviewSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: hidden ? "REVIEW_HIDE" : "REVIEW_PUBLISH",
          entityType: "Review",
          entityId: id,
          meta: {
            previousHidden: existing.hidden,
            hidden,
            rating: row.rating,
          },
        },
      });

      return serializeReview(row);
    });

    res.json({ review: updated });
  }),
);
