import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";

export const adminOrdersRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "PAID",
  "DELIVERED",
  "COMPLETED",
  "DISPUTED",
  "REFUNDED",
  "CANCELLED",
  "EXPIRED",
] as const;

const PAYMENT_STATUSES = [
  "PENDING",
  "PAID",
  "FAILED",
  "REFUNDED",
  "CANCELLED",
] as const;

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const partySelect = { id: true, name: true, email: true } as const;

const orderListSelect = {
  id: true,
  status: true,
  amountCents: true,
  feeCents: true,
  paidAt: true,
  deliveredAt: true,
  completedAt: true,
  expiresAt: true,
  createdAt: true,
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
  offer: { select: { id: true, title: true, priceCents: true } },
  buyer: { select: partySelect },
  seller: { select: partySelect },
  payment: {
    select: {
      id: true,
      provider: true,
      providerRef: true,
      status: true,
      amountCents: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} as const;

function serializeOrder(row: {
  id: string;
  status: string;
  amountCents: number;
  feeCents: number;
  paidAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  listing: { id: string; title: string; media: Array<{ url: string }> };
  offer: { id: string; title: string; priceCents: number } | null;
  buyer: { id: string; name: string | null; email: string };
  seller: { id: string; name: string | null; email: string };
  payment: {
    id: string;
    provider: string;
    providerRef: string;
    status: string;
    amountCents: number;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}) {
  return {
    id: row.id,
    status: row.status,
    amountCents: row.amountCents,
    feeCents: row.feeCents,
    netCents: row.amountCents - row.feeCents,
    paidAt: row.paidAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    listing: {
      id: row.listing.id,
      title: row.listing.title,
      coverUrl: row.listing.media[0]?.url ?? null,
    },
    offer: row.offer,
    buyer: row.buyer,
    seller: row.seller,
    payment: row.payment
      ? {
          id: row.payment.id,
          provider: row.payment.provider,
          providerRef: row.payment.providerRef,
          status: row.payment.status,
          amountCents: row.payment.amountCents,
          createdAt: row.payment.createdAt.toISOString(),
          updatedAt: row.payment.updatedAt.toISOString(),
        }
      : null,
  };
}

adminOrdersRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [
        total,
        pendingPayment,
        paid,
        delivered,
        completed,
        disputed,
        refunded,
        cancelled,
        expired,
        paymentsPending,
        paymentsPaid,
        paymentsFailed,
      ] = await Promise.all([
        tx.order.count(),
        tx.order.count({ where: { status: "PENDING_PAYMENT" } }),
        tx.order.count({ where: { status: "PAID" } }),
        tx.order.count({ where: { status: "DELIVERED" } }),
        tx.order.count({ where: { status: "COMPLETED" } }),
        tx.order.count({ where: { status: "DISPUTED" } }),
        tx.order.count({ where: { status: "REFUNDED" } }),
        tx.order.count({ where: { status: "CANCELLED" } }),
        tx.order.count({ where: { status: "EXPIRED" } }),
        tx.payment.count({ where: { status: "PENDING" } }),
        tx.payment.count({ where: { status: "PAID" } }),
        tx.payment.count({ where: { status: "FAILED" } }),
      ]);

      const gmv = await tx.order.aggregate({
        where: { status: { in: ["PAID", "DELIVERED", "COMPLETED"] } },
        _sum: { amountCents: true },
      });

      return {
        total,
        pendingPayment,
        paid,
        delivered,
        completed,
        disputed,
        refunded,
        cancelled,
        expired,
        paymentsPending,
        paymentsPaid,
        paymentsFailed,
        gmvCents: gmv._sum.amountCents ?? 0,
      };
    });
    res.json({ stats });
  }),
);

adminOrdersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.order.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.paymentStatus
            ? { payment: { status: query.paymentStatus } }
            : {}),
          ...(q
            ? {
                OR: [
                  { id: { contains: q, mode: "insensitive" } },
                  {
                    listing: {
                      title: { contains: q, mode: "insensitive" },
                    },
                  },
                  {
                    buyer: { email: { contains: q, mode: "insensitive" } },
                  },
                  {
                    seller: { email: { contains: q, mode: "insensitive" } },
                  },
                  {
                    payment: {
                      providerRef: { contains: q, mode: "insensitive" },
                    },
                  },
                ],
              }
            : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: query.take + 1,
        select: orderListSelect,
      });

      const hasMore = rows.length > query.take;
      const items = hasMore ? rows.slice(0, query.take) : rows;

      return {
        items: items.map(serializeOrder),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

adminOrdersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const detail = await withRlsTransaction({ actor }, async (tx) => {
      const order = await tx.order.findUnique({
        where: { id },
        select: {
          ...orderListSelect,
          listingId: true,
          offerId: true,
          buyerId: true,
          sellerId: true,
          updatedAt: true,
          escrowHold: {
            select: {
              id: true,
              amountCents: true,
              releaseAt: true,
              releasedAt: true,
              createdAt: true,
            },
          },
          dispute: {
            select: {
              id: true,
              status: true,
              resolution: true,
              reason: true,
              createdAt: true,
            },
          },
          conversation: { select: { id: true } },
          ledgerEntries: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              type: true,
              amountCents: true,
              description: true,
              createdAt: true,
            },
          },
        },
      });
      if (!order) return null;

      return {
        order: {
          ...serializeOrder(order),
          listingId: order.listingId,
          offerId: order.offerId,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          updatedAt: order.updatedAt.toISOString(),
          escrowHold: order.escrowHold
            ? {
                id: order.escrowHold.id,
                amountCents: order.escrowHold.amountCents,
                releaseAt: order.escrowHold.releaseAt.toISOString(),
                releasedAt: order.escrowHold.releasedAt?.toISOString() ?? null,
                createdAt: order.escrowHold.createdAt.toISOString(),
              }
            : null,
          dispute: order.dispute
            ? {
                ...order.dispute,
                createdAt: order.dispute.createdAt.toISOString(),
              }
            : null,
          conversationId: order.conversation?.id ?? null,
          ledgerEntries: order.ledgerEntries.map((e) => ({
            ...e,
            createdAt: e.createdAt.toISOString(),
          })),
        },
      };
    });

    if (!detail) {
      throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    }

    res.json(detail);
  }),
);
