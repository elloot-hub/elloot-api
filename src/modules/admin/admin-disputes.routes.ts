import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { resolveDispute } from "../disputes/disputes.service";

export const adminDisputesRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const listQuerySchema = z.object({
  status: z
    .enum(["OPEN", "RESOLVED", "CANCELLED", "ALL"])
    .optional()
    .default("OPEN"),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["newest", "oldest", "amount"]).optional().default("oldest"),
  openedBy: z.enum(["buyer", "seller", "admin", "any"]).optional().default("any"),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const resolveSchema = z.object({
  resolution: z.enum(["RELEASE_TO_SELLER", "REFUND_BUYER", "PARTIAL"]),
  notes: z.string().trim().min(5).max(2000),
  sellerAmountCents: z.number().int().positive().optional(),
});

const disputeListSelect = {
  id: true,
  code: true,
  orderId: true,
  openedById: true,
  reason: true,
  status: true,
  resolution: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  openedBy: {
    select: { id: true, name: true, email: true },
  },
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      amountCents: true,
      feeCents: true,
      buyerId: true,
      sellerId: true,
      conversation: { select: { id: true } },
      listing: {
        select: {
          id: true,
          title: true,
          media: {
            orderBy: { sortOrder: "asc" as const },
            take: 1,
            select: { url: true },
          },
        },
      },
      buyer: { select: { id: true, name: true, email: true } },
      seller: { select: { id: true, name: true, email: true, kycStatus: true } },
    },
  },
} as const;

type DisputeListRow = {
  id: string;
  code: string;
  orderId: string;
  openedById: string;
  reason: string;
  status: string;
  resolution: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  openedBy: { id: string; name: string | null; email: string };
  order: {
    id: string;
    code: string;
    status: string;
    amountCents: number;
    feeCents: number;
    buyerId: string;
    sellerId: string;
    conversation: { id: string } | null;
    listing: {
      id: string;
      title: string;
      media: Array<{ url: string }>;
    };
    buyer: { id: string; name: string | null; email: string };
    seller: {
      id: string;
      name: string | null;
      email: string;
      kycStatus: string;
    };
  };
};

function openedByRole(
  row: DisputeListRow,
): "buyer" | "seller" | "admin" {
  if (row.openedById === row.order.buyerId) return "buyer";
  if (row.openedById === row.order.sellerId) return "seller";
  return "admin";
}

function serializeDispute(row: DisputeListRow) {
  const ageHours = Math.max(
    0,
    (Date.now() - row.createdAt.getTime()) / 3_600_000,
  );
  return {
    id: row.id,
    code: row.code,
    orderId: row.orderId,
    openedById: row.openedById,
    openedByRole: openedByRole(row),
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ageHours,
    openedBy: row.openedBy,
    order: {
      id: row.order.id,
      code: row.order.code,
      status: row.order.status,
      amountCents: row.order.amountCents,
      feeCents: row.order.feeCents,
      netCents: row.order.amountCents - row.order.feeCents,
      conversationId: row.order.conversation?.id ?? null,
      buyer: row.order.buyer,
      seller: row.order.seller,
      listing: {
        id: row.order.listing.id,
        title: row.order.listing.title,
        coverUrl: row.order.listing.media[0]?.url ?? null,
      },
    },
  };
}

adminDisputesRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const cutoff48h = new Date(Date.now() - 48 * 3_600_000);

    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [open, resolved, cancelled, openOver48h, openAmount] =
        await Promise.all([
          tx.dispute.count({ where: { status: "OPEN" } }),
          tx.dispute.count({ where: { status: "RESOLVED" } }),
          tx.dispute.count({ where: { status: "CANCELLED" } }),
          tx.dispute.count({
            where: { status: "OPEN", createdAt: { lte: cutoff48h } },
          }),
          tx.dispute.findMany({
            where: { status: "OPEN" },
            select: { order: { select: { amountCents: true } } },
          }),
        ]);

      const openAmountCents = openAmount.reduce(
        (sum, d) => sum + d.order.amountCents,
        0,
      );

      return {
        open,
        resolved,
        cancelled,
        openOver48h,
        openAmountCents,
      };
    });
    res.json({ stats });
  }),
);

adminDisputesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const orderBy =
        query.sort === "oldest"
          ? ([{ createdAt: "asc" as const }, { id: "asc" as const }] as const)
          : query.sort === "amount"
            ? ([
                { order: { amountCents: "desc" as const } },
                { id: "desc" as const },
              ] as const)
            : ([{ createdAt: "desc" as const }, { id: "desc" as const }] as const);

      // openedBy precisa comparar colunas — busca um pouco a mais e filtra.
      const needsOpenedByFilter = query.openedBy !== "any";
      const fetchTake = needsOpenedByFilter
        ? Math.min(100, query.take * 4 + 1)
        : query.take + 1;

      const rows = await tx.dispute.findMany({
        where: {
          ...(query.status !== "ALL" ? { status: query.status } : {}),
          ...(q
            ? {
                OR: [
                  { id: { contains: q, mode: "insensitive" } },
                  { code: { contains: q, mode: "insensitive" } },
                  { reason: { contains: q, mode: "insensitive" } },
                  {
                    order: {
                      code: { contains: q, mode: "insensitive" },
                    },
                  },
                  {
                    order: {
                      listing: {
                        title: { contains: q, mode: "insensitive" },
                      },
                    },
                  },
                  {
                    order: {
                      buyer: {
                        OR: [
                          { email: { contains: q, mode: "insensitive" } },
                          { name: { contains: q, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                  {
                    order: {
                      seller: {
                        OR: [
                          { email: { contains: q, mode: "insensitive" } },
                          { name: { contains: q, mode: "insensitive" } },
                        ],
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
        take: fetchTake,
        select: disputeListSelect,
      });

      const filtered = needsOpenedByFilter
        ? rows.filter((row) => openedByRole(row) === query.openedBy)
        : rows;

      const hasMore = filtered.length > query.take;
      const items = hasMore ? filtered.slice(0, query.take) : filtered;

      return {
        items: items.map(serializeDispute),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

adminDisputesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const dispute = await withRlsTransaction({ actor }, (tx) =>
      tx.dispute.findFirst({
        where: {
          OR: [{ id }, { code: id }],
        },
        select: disputeListSelect,
      }),
    );

    if (!dispute) {
      throw new AppError(404, "Dispute not found", "DISPUTE_NOT_FOUND");
    }

    res.json({ dispute: serializeDispute(dispute) });
  }),
);

adminDisputesRouter.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    const body = resolveSchema.parse(req.body);
    const actor = actorOf(req);
    const dispute = await resolveDispute({
      disputeId: routeParam(req.params.id),
      resolution: body.resolution,
      notes: body.notes,
      sellerAmountCents: body.sellerAmountCents,
      actor,
    });
    res.json({ dispute });
  }),
);
