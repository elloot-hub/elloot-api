import { Router } from "express";
import { z } from "zod";
import {
  creditWallet,
  withRlsTransaction,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { completeOrderTx } from "../orders/orders.lifecycle";
import { routes } from "../conversations/hrefs";
import { notifyUser } from "../conversations/notifications.notify";

export const adminFinanceRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

function formatBrl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function maskPixKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "••••";
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-3)}`;
}

const PAYOUT_STATUSES = ["REQUESTED", "PAID", "FAILED", "CANCELLED"] as const;

const payoutListQuery = z.object({
  status: z
    .enum(["REQUESTED", "PAID", "FAILED", "CANCELLED", "ALL"])
    .optional()
    .default("REQUESTED"),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["oldest", "newest", "amount"]).optional().default("oldest"),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const payoutReviewSchema = z.object({
  status: z.enum(["PAID", "FAILED", "CANCELLED"]),
  note: z.string().trim().min(5).max(1000),
  providerRef: z.string().trim().max(140).optional(),
});

const escrowReleaseSchema = z.object({
  note: z.string().trim().min(5).max(1000),
});

const payoutSelect = {
  id: true,
  code: true,
  userId: true,
  amountCents: true,
  pixKey: true,
  status: true,
  providerRef: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: { id: true, name: true, email: true, kycStatus: true },
  },
} as const;

function serializePayout(row: {
  id: string;
  code: string;
  userId: string;
  amountCents: number;
  pixKey: string;
  status: string;
  providerRef: string | null;
  createdAt: Date;
  updatedAt: Date;
  user: {
    id: string;
    name: string | null;
    email: string;
    kycStatus: string;
  };
}) {
  const ageHours = Math.max(
    0,
    (Date.now() - row.createdAt.getTime()) / 3_600_000,
  );
  return {
    id: row.id,
    code: row.code,
    userId: row.userId,
    amountCents: row.amountCents,
    pixKeyMasked: maskPixKey(row.pixKey),
    pixKey: row.pixKey,
    status: row.status,
    providerRef: row.providerRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ageHours,
    user: row.user,
  };
}

adminFinanceRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const now = new Date();
      const cutoff24h = new Date(Date.now() - 24 * 3_600_000);
      const [
        payoutsRequested,
        payoutsPaid,
        payoutsFailed,
        payoutsCancelled,
        payoutsRequestedOver24h,
        escrowOpen,
        escrowDue,
      ] = await Promise.all([
        tx.payout.count({ where: { status: "REQUESTED" } }),
        tx.payout.count({ where: { status: "PAID" } }),
        tx.payout.count({ where: { status: "FAILED" } }),
        tx.payout.count({ where: { status: "CANCELLED" } }),
        tx.payout.count({
          where: { status: "REQUESTED", createdAt: { lte: cutoff24h } },
        }),
        tx.escrowHold.count({ where: { releasedAt: null } }),
        tx.escrowHold.count({
          where: {
            releasedAt: null,
            releaseAt: { lte: now },
            order: { status: { in: ["PAID", "DELIVERED"] } },
          },
        }),
      ]);

      const requestedSum = await tx.payout.aggregate({
        where: { status: "REQUESTED" },
        _sum: { amountCents: true },
      });
      const escrowSum = await tx.escrowHold.aggregate({
        where: { releasedAt: null },
        _sum: { amountCents: true },
      });

      return {
        payoutsRequested,
        payoutsPaid,
        payoutsFailed,
        payoutsCancelled,
        payoutsRequestedOver24h,
        payoutsRequestedCents: requestedSum._sum.amountCents ?? 0,
        escrowOpen,
        escrowDue,
        escrowOpenCents: escrowSum._sum.amountCents ?? 0,
      };
    });
    res.json({ stats });
  }),
);

adminFinanceRouter.get(
  "/payouts",
  asyncHandler(async (req, res) => {
    const query = payoutListQuery.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const orderBy =
        query.sort === "newest"
          ? ([{ createdAt: "desc" as const }, { id: "desc" as const }] as const)
          : query.sort === "amount"
            ? ([
                { amountCents: "desc" as const },
                { id: "desc" as const },
              ] as const)
            : ([{ createdAt: "asc" as const }, { id: "asc" as const }] as const);

      const rows = await tx.payout.findMany({
        where: {
          ...(query.status !== "ALL" ? { status: query.status } : {}),
          ...(q
            ? {
                OR: [
                  { id: { contains: q, mode: "insensitive" } },
                  { code: { contains: q, mode: "insensitive" } },
                  { pixKey: { contains: q, mode: "insensitive" } },
                  { providerRef: { contains: q, mode: "insensitive" } },
                  {
                    user: {
                      OR: [
                        { email: { contains: q, mode: "insensitive" } },
                        { name: { contains: q, mode: "insensitive" } },
                      ],
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
        select: payoutSelect,
      });
      const hasMore = rows.length > query.take;
      const items = hasMore ? rows.slice(0, query.take) : rows;
      return {
        items: items.map(serializePayout),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

adminFinanceRouter.get(
  "/payouts/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);
    const payout = await withRlsTransaction({ actor }, (tx) =>
      tx.payout.findUnique({ where: { id }, select: payoutSelect }),
    );
    if (!payout) {
      throw new AppError(404, "Payout not found", "PAYOUT_NOT_FOUND");
    }
    res.json({ payout: serializePayout(payout) });
  }),
);

adminFinanceRouter.post(
  "/payouts/:id/review",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const body = payoutReviewSchema.parse(req.body);
    const actor = actorOf(req);
    const note = sanitizeUserText(body.note, 1000);

    const payout = await withServiceTransaction(async (tx) => {
      const existing = await tx.payout.findUnique({
        where: { id },
        select: {
          id: true,
          userId: true,
          amountCents: true,
          status: true,
        },
      });
      if (!existing) {
        throw new AppError(404, "Payout not found", "PAYOUT_NOT_FOUND");
      }
      if (existing.status !== "REQUESTED") {
        throw new AppError(409, "Payout is not pending", "INVALID_STATUS");
      }

      if (body.status === "FAILED" || body.status === "CANCELLED") {
        await creditWallet(tx, {
          userId: existing.userId,
          type: "ADJUSTMENT",
          amountCents: existing.amountCents,
          description: `Estorno de saque ${existing.id} (${body.status})`,
        });
      }

      const updated = await tx.payout.update({
        where: { id },
        data: {
          status: body.status,
          providerRef: body.providerRef?.trim() || undefined,
        },
        select: payoutSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: `payout.${body.status.toLowerCase()}`,
          entityType: "Payout",
          entityId: id,
          meta: {
            note,
            amountCents: existing.amountCents,
            providerRef: body.providerRef ?? null,
          },
        },
      });

      return serializePayout(updated);
    }, actor);

    const title =
      body.status === "PAID"
        ? "Saque pago"
        : body.status === "FAILED"
          ? "Saque falhou"
          : "Saque cancelado";
    const bodyText =
      body.status === "PAID"
        ? `${formatBrl(payout.amountCents)} foi enviado para sua chave PIX.`
        : `${formatBrl(payout.amountCents)} voltou para o saldo.`;

    void notifyUser({
      userId: payout.userId,
      type: "SYSTEM",
      title,
      body: bodyText,
      href: routes.dashboardWithdrawals,
      meta: { payoutId: payout.id, status: body.status },
    });

    res.json({ payout });
  }),
);

adminFinanceRouter.get(
  "/escrow",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const take = Math.min(Number(req.query.take) || 40, 100);
    const dueOnly = String(req.query.dueOnly ?? "") === "1";
    const now = new Date();

    const holds = await withRlsTransaction({ actor }, (tx) =>
      tx.escrowHold.findMany({
        where: {
          releasedAt: null,
          ...(dueOnly ? { releaseAt: { lte: now } } : {}),
          order: { status: { in: ["PAID", "DELIVERED"] } },
        },
        orderBy: { releaseAt: "asc" },
        take,
        select: {
          id: true,
          orderId: true,
          amountCents: true,
          releaseAt: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              status: true,
              amountCents: true,
              feeCents: true,
              listing: { select: { id: true, title: true } },
              seller: { select: { id: true, name: true, email: true } },
              buyer: { select: { id: true, name: true, email: true } },
            },
          },
        },
      }),
    );

    res.json({
      items: holds.map((h) => ({
        id: h.id,
        orderId: h.orderId,
        amountCents: h.amountCents,
        releaseAt: h.releaseAt.toISOString(),
        createdAt: h.createdAt.toISOString(),
        due: h.releaseAt <= now,
        order: h.order,
      })),
    });
  }),
);

adminFinanceRouter.post(
  "/escrow/:orderId/release",
  asyncHandler(async (req, res) => {
    const orderId = routeParam(req.params.orderId);
    const body = escrowReleaseSchema.parse(req.body);
    const actor = actorOf(req);
    const note = sanitizeUserText(body.note, 1000);

    const order = await withServiceTransaction(async (tx) => {
      const hold = await tx.escrowHold.findUnique({
        where: { orderId },
        select: { releasedAt: true, order: { select: { status: true } } },
      });
      if (!hold) {
        throw new AppError(404, "Escrow not found", "ESCROW_NOT_FOUND");
      }
      if (hold.releasedAt) {
        throw new AppError(409, "Escrow already released", "INVALID_STATUS");
      }
      if (!["PAID", "DELIVERED"].includes(hold.order.status)) {
        throw new AppError(
          409,
          "Order cannot be released from escrow",
          "INVALID_STATUS",
        );
      }

      const completed = await completeOrderTx(tx, orderId);
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "escrow.manual_release",
          entityType: "Order",
          entityId: orderId,
          meta: { note },
        },
      });
      return completed;
    }, actor);

    res.json({ order });
  }),
);
