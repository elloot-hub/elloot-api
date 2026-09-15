import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
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
