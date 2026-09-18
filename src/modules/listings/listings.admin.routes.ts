import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import {
  approveModerationTx,
  buildProposedSnapshot,
  diffSnapshots,
  loadListingSnapshotTx,
  moderationQueueListSelect,
  rejectModerationTx,
  serializeModerationQueueItem,
} from "./listings.moderation";
import { listingPublicSelect } from "./listings.shared";
import { routes } from "../conversations/hrefs";
import { notifyUser } from "../conversations/notifications.notify";

export const listingsAdminRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

const listQuerySchema = z.object({
  status: z
    .enum(["PENDING", "APPROVED", "REJECTED", "ALL"])
    .optional()
    .default("PENDING"),
  type: z.enum(["INITIAL", "REVISION", "ALL"]).optional().default("ALL"),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["oldest", "newest", "price"]).optional().default("oldest"),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const rejectSchema = z.object({
  reviewNote: z.string().trim().min(5).max(1000),
});

/** Moderation queue stats for admin dashboard widgets. */
listingsAdminRouter.get(
  "/moderation/stats",
  asyncHandler(async (_req, res) => {
    const actor = actorOf(_req);
    const cutoff24h = new Date(Date.now() - 24 * 3_600_000);

    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [pending, initial, revision, approved, rejected, pendingOver24h, pendingRows] =
        await Promise.all([
          tx.listingModerationQueue.count({ where: { status: "PENDING" } }),
          tx.listingModerationQueue.count({
            where: { status: "PENDING", type: "INITIAL" },
          }),
          tx.listingModerationQueue.count({
            where: { status: "PENDING", type: "REVISION" },
          }),
          tx.listingModerationQueue.count({ where: { status: "APPROVED" } }),
          tx.listingModerationQueue.count({ where: { status: "REJECTED" } }),
          tx.listingModerationQueue.count({
            where: { status: "PENDING", createdAt: { lte: cutoff24h } },
          }),
          tx.listingModerationQueue.findMany({
            where: { status: "PENDING" },
            select: { listing: { select: { priceCents: true } } },
          }),
        ]);

      const pendingAmountCents = pendingRows.reduce(
        (sum, row) => sum + row.listing.priceCents,
        0,
      );

      return {
        pending,
        initial,
        revision,
        approved,
        rejected,
        pendingOver24h,
        pendingAmountCents,
      };
    });
    res.json({ stats });
  }),
);

/** Paginated moderation queue. */
listingsAdminRouter.get(
  "/moderation",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const orderBy =
        query.sort === "newest"
          ? ([{ createdAt: "desc" as const }, { id: "desc" as const }] as const)
          : query.sort === "price"
            ? ([
                { listing: { priceCents: "desc" as const } },
                { id: "desc" as const },
              ] as const)
            : ([{ createdAt: "asc" as const }, { id: "asc" as const }] as const);

      const rows = await tx.listingModerationQueue.findMany({
        where: {
          ...(query.status !== "ALL" ? { status: query.status } : {}),
          ...(query.type !== "ALL" ? { type: query.type } : {}),
          ...(q
            ? {
                OR: [
                  { id: { contains: q, mode: "insensitive" } },
                  {
                    listing: {
                      code: { contains: q, mode: "insensitive" },
                    },
                  },
                  {
                    listing: {
                      title: { contains: q, mode: "insensitive" },
                    },
                  },
                  {
                    listing: {
                      seller: {
                        OR: [
                          { email: { contains: q, mode: "insensitive" } },
                          { name: { contains: q, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                  {
                    listing: {
                      category: {
                        name: { contains: q, mode: "insensitive" },
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: [...orderBy],
        ...(query.cursor
          ? { cursor: { id: query.cursor }, skip: 1 }
          : {}),
        take: query.take + 1,
        select: moderationQueueListSelect,
      });

      const hasMore = rows.length > query.take;
      const items = hasMore ? rows.slice(0, query.take) : rows;

      return {
        items: items.map(serializeModerationQueueItem),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

/** Full moderation detail with live vs proposed diff. */
listingsAdminRouter.get(
  "/moderation/:queueId",
  asyncHandler(async (req, res) => {
    const queueId = routeParam(req.params.queueId);
    const actor = actorOf(req);

    const detail = await withRlsTransaction({ actor }, async (tx) => {
      const item = await tx.listingModerationQueue.findUnique({
        where: { id: queueId },
        select: {
          ...moderationQueueListSelect,
          payload: true,
          reviewedBy: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      if (!item) return null;

      const live = await loadListingSnapshotTx(tx, item.listingId);
      if (!live) return null;

      const listing = await tx.listing.findUnique({
        where: { id: item.listingId },
        select: listingPublicSelect,
      });

      const payload = (item.payload ?? {}) as Record<string, unknown>;
      const proposed =
        item.type === "INITIAL"
          ? live
          : buildProposedSnapshot(live, payload as never);

      const diff =
        item.type === "INITIAL"
          ? [{ field: "initial", before: null, after: "full_listing_review" }]
          : diffSnapshots(live, proposed);

      return {
        item: {
          ...serializeModerationQueueItem(item),
          payload,
          reviewedBy: item.reviewedBy,
        },
        listing,
        live,
        proposed,
        diff,
      };
    });

    if (!detail) {
      throw new AppError(404, "Moderation item not found", "NOT_FOUND");
    }

    res.json(detail);
  }),
);

/** Approve queued initial publish or content revision. */
listingsAdminRouter.post(
  "/moderation/:queueId/approve",
  asyncHandler(async (req, res) => {
    const queueId = routeParam(req.params.queueId);
    const actor = actorOf(req);

    const listing = await withRlsTransaction({ actor }, async (tx) => {
      await approveModerationTx(tx, queueId, actor.id);
      const queue = await tx.listingModerationQueue.findUnique({
        where: { id: queueId },
        select: { listingId: true },
      });
      if (!queue) return null;
      return tx.listing.findUnique({
        where: { id: queue.listingId },
        select: { ...listingPublicSelect, sellerId: true },
      });
    });

    if (listing) {
      void notifyUser({
        userId: listing.sellerId,
        type: "LISTING",
        title: "Anúncio aprovado",
        body: `“${listing.title}” foi aprovado e está ativo.`,
        href: routes.listing(listing.id),
        meta: { listingId: listing.id },
      });
    }

    res.json({ listing, queueId, status: "APPROVED" });
  }),
);

/** Reject queued item with reason (seller-visible for INITIAL). */
listingsAdminRouter.post(
  "/moderation/:queueId/reject",
  asyncHandler(async (req, res) => {
    const queueId = routeParam(req.params.queueId);
    const body = rejectSchema.parse(req.body);
    const actor = actorOf(req);

    const listing = await withRlsTransaction({ actor }, async (tx) => {
      await rejectModerationTx(tx, queueId, actor.id, body.reviewNote);
      const queue = await tx.listingModerationQueue.findUnique({
        where: { id: queueId },
        select: { listingId: true },
      });
      if (!queue) return null;
      return tx.listing.findUnique({
        where: { id: queue.listingId },
        select: { ...listingPublicSelect, sellerId: true },
      });
    });

    if (listing) {
      void notifyUser({
        userId: listing.sellerId,
        type: "LISTING",
        title: "Anúncio rejeitado",
        body: `“${listing.title}” precisa de ajustes. Veja a nota de moderação.`,
        href: routes.dashboardListings,
        meta: { listingId: listing.id },
      });
    }

    res.json({ listing, queueId, status: "REJECTED" });
  }),
);

/** Listings awaiting first review (shortcut without queue id). */
listingsAdminRouter.get(
  "/pending-review",
  asyncHandler(async (req, res) => {
    const take = Math.min(Number(req.query.take) || 30, 100);
    const actor = actorOf(req);

    const listings = await withRlsTransaction({ actor }, (tx) =>
      tx.listing.findMany({
        where: { status: "PENDING_REVIEW" },
        orderBy: { submittedForReviewAt: "desc" },
        take,
        select: listingPublicSelect,
      }),
    );

    res.json({ listings });
  }),
);

const catalogListSchema = z.object({
  status: z
    .enum([
      "DRAFT",
      "ACTIVE",
      "PAUSED",
      "SOLD",
      "REMOVED",
      "PENDING_REVIEW",
      "REJECTED",
      "ALL",
    ])
    .optional()
    .default("ALL"),
  q: z.string().trim().max(120).optional(),
  sort: z
    .enum(["newest", "oldest", "price_desc", "price_asc", "sales"])
    .optional()
    .default("newest"),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const adminListingUpdateSchema = z
  .object({
    title: z.string().trim().min(5).max(120).optional(),
    description: z.string().trim().min(20).max(5000).optional(),
    priceCents: z.number().int().min(150).max(50_000_000).optional(),
    stockQuantity: z.number().int().min(0).max(1_000_000).optional(),
    status: z
      .enum(["DRAFT", "ACTIVE", "PAUSED", "REMOVED", "PENDING_REVIEW", "REJECTED"])
      .optional(),
    productType: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
      .optional()
      .nullable(),
    reachPlanId: z.string().min(1).optional().nullable(),
    moderationNote: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field",
  });

function serializeAdminListing(row: {
  id: string;
  code: string;
  title: string;
  description: string;
  priceCents: number;
  stockQuantity: number;
  unitsSold: number;
  salesCount: number;
  productType: string | null;
  listingModel: string;
  deliveryMode: string;
  status: string;
  reachPlanId: string | null;
  feeBps: number | null;
  reachPriority: number;
  moderationNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  category: {
    id: string;
    name: string;
    slugPath: string;
  };
  media: Array<{ id: string; url: string; sortOrder: number }>;
  seller: {
    id: string;
    name: string | null;
    username: string | null;
    avatarUrl: string | null;
  };
  reachPlan: {
    id: string;
    code: string;
    title: string;
    feeBps: number;
  } | null;
}) {
  const cover = [...row.media].sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    priceCents: row.priceCents,
    stockQuantity: row.stockQuantity,
    unitsSold: row.unitsSold,
    salesCount: row.salesCount,
    productType: row.productType,
    listingModel: row.listingModel,
    deliveryMode: row.deliveryMode,
    status: row.status,
    reachPlanId: row.reachPlanId,
    feeBps: row.feeBps,
    reachPriority: row.reachPriority,
    moderationNote: row.moderationNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    coverUrl: cover?.url ?? null,
    category: row.category,
    media: row.media,
    seller: row.seller,
    reachPlan: row.reachPlan
      ? {
          ...row.reachPlan,
          feePercent: Math.round((row.reachPlan.feeBps / 100) * 100) / 100,
        }
      : null,
  };
}

const adminListingSelect = {
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
  reachPlanId: true,
  feeBps: true,
  reachPriority: true,
  moderationNote: true,
  createdAt: true,
  updatedAt: true,
  category: {
    select: { id: true, name: true, slugPath: true },
  },
  media: {
    orderBy: { sortOrder: "asc" as const },
    select: { id: true, url: true, sortOrder: true },
  },
  seller: {
    select: {
      id: true,
      name: true,
      username: true,
      avatarUrl: true,
    },
  },
  reachPlan: {
    select: { id: true, code: true, title: true, feeBps: true },
  },
} as const;

/** Catalog stats for the products admin page. */
listingsAdminRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [total, active, paused, pendingReview, removed] = await Promise.all([
        tx.listing.count(),
        tx.listing.count({ where: { status: "ACTIVE" } }),
        tx.listing.count({ where: { status: "PAUSED" } }),
        tx.listing.count({ where: { status: "PENDING_REVIEW" } }),
        tx.listing.count({ where: { status: "REMOVED" } }),
      ]);
      return { total, active, paused, pendingReview, removed };
    });
    res.json({ stats });
  }),
);

/** Paginated catalog of all listings (admin product management). */
listingsAdminRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = catalogListSchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const orderBy =
        query.sort === "oldest"
          ? ([{ createdAt: "asc" as const }, { id: "asc" as const }] as const)
          : query.sort === "price_desc"
            ? ([{ priceCents: "desc" as const }, { id: "desc" as const }] as const)
            : query.sort === "price_asc"
              ? ([{ priceCents: "asc" as const }, { id: "asc" as const }] as const)
              : query.sort === "sales"
                ? ([
                    { salesCount: "desc" as const },
                    { createdAt: "desc" as const },
                  ] as const)
                : ([{ createdAt: "desc" as const }, { id: "desc" as const }] as const);

      const rows = await tx.listing.findMany({
        where: {
          ...(query.status !== "ALL" ? { status: query.status } : {}),
          ...(q
            ? {
                OR: [
                  { id: { contains: q, mode: "insensitive" as const } },
                  { code: { contains: q, mode: "insensitive" as const } },
                  { title: { contains: q, mode: "insensitive" as const } },
                  {
                    seller: {
                      OR: [
                        { name: { contains: q, mode: "insensitive" as const } },
                        {
                          username: {
                            contains: q,
                            mode: "insensitive" as const,
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: [...orderBy],
        take: query.take + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        select: adminListingSelect,
      });

      const hasMore = rows.length > query.take;
      const page = hasMore ? rows.slice(0, query.take) : rows;
      return {
        items: page.map(serializeAdminListing),
        nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

listingsAdminRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const listing = await withRlsTransaction({ actor }, async (tx) => {
      const row = await tx.listing.findUnique({
        where: { id },
        select: adminListingSelect,
      });
      return row ? serializeAdminListing(row) : null;
    });

    if (!listing) {
      throw new AppError(404, "Listing not found", "NOT_FOUND");
    }
    res.json({ listing });
  }),
);

/** Admin force-update (bypasses seller moderation queue). */
listingsAdminRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const body = adminListingUpdateSchema.parse(req.body);
    const actor = actorOf(req);

    const listing = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.listing.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new AppError(404, "Listing not found", "NOT_FOUND");
      }
      if (existing.status === "SOLD") {
        throw new AppError(409, "Listing already sold", "LISTING_SOLD");
      }

      let reachFields: {
        reachPlanId: string | null;
        feeBps: number | null;
        reachPriority: number;
      } | null = null;

      if (body.reachPlanId !== undefined) {
        if (body.reachPlanId === null) {
          reachFields = {
            reachPlanId: null,
            feeBps: null,
            reachPriority: 0,
          };
        } else {
          const plan = await tx.reachPlan.findFirst({
            where: { id: body.reachPlanId, active: true },
            select: { id: true, feeBps: true, priority: true },
          });
          if (!plan) {
            throw new AppError(400, "Plano de alcance inválido", "REACH_PLAN_INVALID");
          }
          reachFields = {
            reachPlanId: plan.id,
            feeBps: plan.feeBps,
            reachPriority: plan.priority,
          };
        }
      }

      const updated = await tx.listing.update({
        where: { id },
        data: {
          ...(body.title !== undefined
            ? { title: sanitizeUserText(body.title, 120) }
            : {}),
          ...(body.description !== undefined
            ? { description: sanitizeUserText(body.description, 5000) }
            : {}),
          ...(body.priceCents !== undefined
            ? { priceCents: body.priceCents }
            : {}),
          ...(body.stockQuantity !== undefined
            ? { stockQuantity: body.stockQuantity }
            : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.productType !== undefined
            ? { productType: body.productType }
            : {}),
          ...(body.moderationNote !== undefined
            ? {
                moderationNote:
                  body.moderationNote != null
                    ? sanitizeUserText(body.moderationNote, 1000) || null
                    : null,
              }
            : {}),
          ...(reachFields ?? {}),
        },
        select: adminListingSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "listing.admin_updated",
          entityType: "Listing",
          entityId: id,
          meta: body,
        },
      });

      return serializeAdminListing(updated);
    });

    res.json({ listing });
  }),
);
