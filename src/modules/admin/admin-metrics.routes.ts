import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";

export const adminMetricsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const PAID_STATUSES = ["PAID", "DELIVERED", "COMPLETED"] as const;
const DAY_MS = 86_400_000;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function deltaOf(current: number, previous: number) {
  const changePct =
    previous === 0
      ? current > 0
        ? 100
        : 0
      : Math.round(((current - previous) / previous) * 1000) / 10;
  return {
    changePct,
    trend: (changePct > 0.2 ? "up" : changePct < -0.2 ? "down" : "flat") as
      | "up"
      | "down"
      | "flat",
  };
}

function severityOf(pending: number, oldestWaitHours: number) {
  if (pending === 0) return "ok" as const;
  if (oldestWaitHours >= 24 || pending >= 20) return "critical" as const;
  if (oldestWaitHours >= 8 || pending >= 8) return "attention" as const;
  return "ok" as const;
}

function waitHours(oldest: Date | null | undefined) {
  if (!oldest) return 0;
  return Math.max(0, Math.round((Date.now() - oldest.getTime()) / 3_600_000));
}

const periodSchema = z.object({
  period: z
    .union([z.literal("7"), z.literal("30"), z.literal("90"), z.literal(7), z.literal(30), z.literal(90)])
    .optional()
    .default(30)
    .transform((v) => Number(v) as 7 | 30 | 90),
});

adminMetricsRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { period } = periodSchema.parse(req.query);

    const rangeEnd = new Date();
    rangeEnd.setHours(23, 59, 59, 999);
    const rangeStart = new Date(rangeEnd.getTime() - (period - 1) * DAY_MS);
    rangeStart.setHours(0, 0, 0, 0);

    const prevEnd = new Date(rangeStart.getTime() - 1);
    prevEnd.setHours(23, 59, 59, 999);
    const prevStart = new Date(prevEnd.getTime() - (period - 1) * DAY_MS);
    prevStart.setHours(0, 0, 0, 0);

    const overview = await withRlsTransaction({ actor }, async (tx) => {
      const paidWhere = {
        status: { in: [...PAID_STATUSES] },
      };

      const [currentOrders, prevOrders, currentUsers, prevUsers, openDisputes] =
        await Promise.all([
          tx.order.findMany({
            where: {
              ...paidWhere,
              createdAt: { gte: rangeStart, lte: rangeEnd },
            },
            select: {
              createdAt: true,
              amountCents: true,
              status: true,
              sellerId: true,
              listing: {
                select: {
                  categoryId: true,
                  category: { select: { id: true, name: true } },
                },
              },
              seller: {
                select: { id: true, name: true, avatarUrl: true },
              },
            },
          }),
          tx.order.findMany({
            where: {
              ...paidWhere,
              createdAt: { gte: prevStart, lte: prevEnd },
            },
            select: { amountCents: true, status: true },
          }),
          tx.user.count({
            where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
          }),
          tx.user.count({
            where: { createdAt: { gte: prevStart, lte: prevEnd } },
          }),
          tx.dispute.count({ where: { status: "OPEN" } }),
        ]);

      const [prevOpenDisputesOpened, currentCompleted, prevCompleted, currentTerminal, prevTerminal] =
        await Promise.all([
          tx.dispute.count({
            where: {
              createdAt: { gte: prevStart, lte: prevEnd },
            },
          }),
          tx.order.count({
            where: {
              status: "COMPLETED",
              createdAt: { gte: rangeStart, lte: rangeEnd },
            },
          }),
          tx.order.count({
            where: {
              status: "COMPLETED",
              createdAt: { gte: prevStart, lte: prevEnd },
            },
          }),
          tx.order.count({
            where: {
              status: {
                in: ["COMPLETED", "DISPUTED", "REFUNDED", "CANCELLED", "EXPIRED"],
              },
              createdAt: { gte: rangeStart, lte: rangeEnd },
            },
          }),
          tx.order.count({
            where: {
              status: {
                in: ["COMPLETED", "DISPUTED", "REFUNDED", "CANCELLED", "EXPIRED"],
              },
              createdAt: { gte: prevStart, lte: prevEnd },
            },
          }),
        ]);

      const currentOpenDisputesOpened = await tx.dispute.count({
        where: { createdAt: { gte: rangeStart, lte: rangeEnd } },
      });

      const salesByDay = new Map<string, { salesCents: number; orders: number }>();
      for (const day of eachDay(rangeStart, rangeEnd)) {
        salesByDay.set(dayKey(day), { salesCents: 0, orders: 0 });
      }
      for (const o of currentOrders) {
        const k = dayKey(o.createdAt);
        const bucket = salesByDay.get(k) ?? { salesCents: 0, orders: 0 };
        bucket.salesCents += o.amountCents;
        bucket.orders += 1;
        salesByDay.set(k, bucket);
      }

      const salesSeries = [...salesByDay.entries()].map(([date, v]) => ({
        date,
        salesCents: v.salesCents,
        orders: v.orders,
      }));

      const totalSoldCents = currentOrders.reduce((s, o) => s + o.amountCents, 0);
      const orders = currentOrders.length;
      const prevSold = prevOrders.reduce((s, o) => s + o.amountCents, 0);
      const prevOrderCount = prevOrders.length;

      const averageTicketCents =
        orders > 0 ? Math.round(totalSoldCents / orders) : 0;
      const prevTicket =
        prevOrderCount > 0 ? Math.round(prevSold / prevOrderCount) : 0;

      const completionRatePct =
        currentTerminal > 0
          ? Math.round((currentCompleted / currentTerminal) * 1000) / 10
          : 0;
      const prevCompletion =
        prevTerminal > 0
          ? Math.round((prevCompleted / prevTerminal) * 1000) / 10
          : 0;

      const categoryMap = new Map<
        string,
        { id: string; name: string; orders: number; totalCents: number }
      >();
      for (const o of currentOrders) {
        const cat = o.listing.category;
        const row = categoryMap.get(cat.id) ?? {
          id: cat.id,
          name: cat.name,
          orders: 0,
          totalCents: 0,
        };
        row.orders += 1;
        row.totalCents += o.amountCents;
        categoryMap.set(cat.id, row);
      }
      const topCategories = [...categoryMap.values()]
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 8);

      const sellerMap = new Map<
        string,
        {
          id: string;
          name: string;
          avatarUrl: string | null;
          sales: number;
          totalCents: number;
        }
      >();
      for (const o of currentOrders) {
        const s = o.seller;
        const row = sellerMap.get(s.id) ?? {
          id: s.id,
          name: s.name?.trim() || "Vendedor",
          avatarUrl: s.avatarUrl,
          sales: 0,
          totalCents: 0,
        };
        row.sales += 1;
        row.totalCents += o.amountCents;
        sellerMap.set(s.id, row);
      }

      const topSellerIds = [...sellerMap.values()]
        .sort((a, b) => b.totalCents - a.totalCents)
        .slice(0, 8)
        .map((s) => s.id);

      const ratings =
        topSellerIds.length === 0
          ? []
          : await tx.review.findMany({
              where: { sellerId: { in: topSellerIds }, hidden: false },
              select: { sellerId: true, rating: true },
            });

      const ratingBySeller = new Map<string, { sum: number; n: number }>();
      for (const r of ratings) {
        const agg = ratingBySeller.get(r.sellerId) ?? { sum: 0, n: 0 };
        agg.sum += r.rating;
        agg.n += 1;
        ratingBySeller.set(r.sellerId, agg);
      }

      const topSellers = topSellerIds.map((id) => {
        const base = sellerMap.get(id)!;
        const agg = ratingBySeller.get(id);
        return {
          ...base,
          rating:
            agg && agg.n > 0
              ? Math.round((agg.sum / agg.n) * 10) / 10
              : 0,
        };
      });

      return {
        period,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        kpis: {
          totalSoldCents,
          orders,
          averageTicketCents,
          newUsers: currentUsers,
          completionRatePct,
          openDisputes,
        },
        deltas: {
          totalSoldCents: deltaOf(totalSoldCents, prevSold),
          orders: deltaOf(orders, prevOrderCount),
          averageTicketCents: deltaOf(averageTicketCents, prevTicket),
          newUsers: deltaOf(currentUsers, prevUsers),
          completionRatePct: deltaOf(completionRatePct, prevCompletion),
          openDisputes: deltaOf(
            currentOpenDisputesOpened,
            prevOpenDisputesOpened,
          ),
        },
        salesSeries,
        topCategories,
        topSellers,
      };
    });

    res.json(overview);
  }),
);

adminMetricsRouter.get(
  "/operational-health",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const queues = await withRlsTransaction({ actor }, async (tx) => {
      const [
        listingsPending,
        listingsOldest,
        docsPending,
        docsOldest,
        disputesOpen,
        disputesOldest,
        payoutsRequested,
        payoutsOldest,
      ] = await Promise.all([
        tx.listingModerationQueue.count({ where: { status: "PENDING" } }),
        tx.listingModerationQueue.findFirst({
          where: { status: "PENDING" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        tx.user.count({ where: { kycStatus: "PENDING" } }),
        tx.kycSubmission.findFirst({
          where: { status: "PENDING" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        tx.dispute.count({ where: { status: "OPEN" } }),
        tx.dispute.findFirst({
          where: { status: "OPEN" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
        tx.payout.count({ where: { status: "REQUESTED" } }),
        tx.payout.findFirst({
          where: { status: "REQUESTED" },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
      ]);

      const rows = [
        {
          key: "listings" as const,
          pending: listingsPending,
          oldestWaitHours: waitHours(listingsOldest?.createdAt),
        },
        {
          key: "documents" as const,
          pending: docsPending,
          oldestWaitHours: waitHours(docsOldest?.createdAt),
        },
        {
          key: "disputes" as const,
          pending: disputesOpen,
          oldestWaitHours: waitHours(disputesOldest?.createdAt),
        },
        {
          key: "payouts" as const,
          pending: payoutsRequested,
          oldestWaitHours: waitHours(payoutsOldest?.createdAt),
        },
      ];

      return rows.map((row) => ({
        ...row,
        severity: severityOf(row.pending, row.oldestWaitHours),
      }));
    });

    res.json({ queues });
  }),
);
