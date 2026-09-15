import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";

export const adminStatsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

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

const seriesQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

/** Time-series for the admin overview charts */
adminStatsRouter.get(
  "/series",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = seriesQuerySchema.parse(req.query);

    const toDate = query.to ? new Date(query.to) : new Date();
    toDate.setHours(23, 59, 59, 999);

    const fromDate = query.from
      ? new Date(query.from)
      : new Date(toDate.getTime() - (query.days - 1) * 86_400_000);
    fromDate.setHours(0, 0, 0, 0);

    const series = await withRlsTransaction({ actor }, async (tx) => {
      const [orders, users, registrations] = await Promise.all([
        // GMV per day
        tx.order.findMany({
          where: {
            status: { in: ["PAID", "DELIVERED", "COMPLETED"] },
            createdAt: { gte: fromDate, lte: toDate },
          },
          select: { createdAt: true, amountCents: true, feeCents: true },
        }),
        // new users per day
        tx.user.findMany({
          where: { createdAt: { gte: fromDate, lte: toDate } },
          select: { createdAt: true },
        }),
        // total users at start (for cumulative)
        tx.user.count({ where: { createdAt: { lt: fromDate } } }),
      ]);

      const days = eachDay(fromDate, toDate);

      const gmvByDay = new Map<string, number>();
      const feesbyDay = new Map<string, number>();
      const ordersCountByDay = new Map<string, number>();
      const usersCountByDay = new Map<string, number>();

      for (const o of orders) {
        const k = dayKey(o.createdAt);
        gmvByDay.set(k, (gmvByDay.get(k) ?? 0) + o.amountCents);
        feesbyDay.set(k, (feesbyDay.get(k) ?? 0) + o.feeCents);
        ordersCountByDay.set(k, (ordersCountByDay.get(k) ?? 0) + 1);
      }
      for (const u of users) {
        const k = dayKey(u.createdAt);
        usersCountByDay.set(k, (usersCountByDay.get(k) ?? 0) + 1);
      }

      let cumulativeUsers = registrations;
      return days.map((day) => {
        const k = dayKey(day);
        const newUsers = usersCountByDay.get(k) ?? 0;
        cumulativeUsers += newUsers;
        return {
          date: k,
          gmvCents: gmvByDay.get(k) ?? 0,
          feesCents: feesbyDay.get(k) ?? 0,
          orders: ordersCountByDay.get(k) ?? 0,
          newUsers,
          totalUsers: cumulativeUsers,
        };
      });
    });

    res.json({ series });
  }),
);

/** KPIs for the admin overview page. */
adminStatsRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [
        users,
        listingsActive,
        listingsPendingReview,
        ordersPaid,
        ordersDisputed,
        disputesOpen,
        moderationPending,
        payoutsRequested,
        kycPending,
      ] = await Promise.all([
        tx.user.count(),
        tx.listing.count({ where: { status: "ACTIVE" } }),
        tx.listing.count({ where: { status: "PENDING_REVIEW" } }),
        tx.order.count({ where: { status: { in: ["PAID", "DELIVERED", "COMPLETED"] } } }),
        tx.order.count({ where: { status: "DISPUTED" } }),
        tx.dispute.count({ where: { status: "OPEN" } }),
        tx.listingModerationQueue.count({ where: { status: "PENDING" } }),
        tx.payout.count({ where: { status: "REQUESTED" } }),
        tx.user.count({ where: { kycStatus: "PENDING" } }),
      ]);

      const gmv = await tx.order.aggregate({
        where: {
          status: { in: ["PAID", "DELIVERED", "COMPLETED"] },
        },
        _sum: { amountCents: true },
      });

      const platformFees = await tx.walletLedger.aggregate({
        where: { type: "PLATFORM_FEE" },
        _sum: { amountCents: true },
      });

      return {
        users,
        listingsActive,
        listingsPendingReview,
        ordersPaid,
        ordersDisputed,
        disputesOpen,
        moderationPending,
        payoutsRequested,
        kycPending,
        gmvCents: gmv._sum.amountCents ?? 0,
        platformFeesCents: platformFees._sum.amountCents ?? 0,
      };
    });

    res.json({ stats });
  }),
);
