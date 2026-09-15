import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export type PendingReleaseHold = {
  orderId: string;
  orderCode: string;
  listingTitle: string;
  netCents: number;
  releaseAt: string | null;
  status: string;
};

export type PendingReleaseBreakdown = {
  totalCents: number;
  releasesTodayCents: number;
  releasesUpcomingCents: number;
  inDisputeCents: number;
  holds: PendingReleaseHold[];
};

function endOfUtcDay(date = new Date()): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999),
  );
}

export async function computePendingReleaseBreakdown(
  tx: Tx,
  sellerId: string,
): Promise<PendingReleaseBreakdown> {
  const orders = await tx.order.findMany({
    where: {
      sellerId,
      status: { in: ["PAID", "DELIVERED", "DISPUTED"] },
    },
    select: {
      id: true,
      code: true,
      status: true,
      amountCents: true,
      feeCents: true,
      listing: { select: { title: true } },
      escrowHold: {
        select: {
          releaseAt: true,
          releasedAt: true,
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 50,
  });

  const cutoff = endOfUtcDay();
  let releasesTodayCents = 0;
  let releasesUpcomingCents = 0;
  let inDisputeCents = 0;
  const holds: PendingReleaseHold[] = [];

  for (const order of orders) {
    const hold = order.escrowHold;
    if (hold?.releasedAt) continue;

    const net = order.amountCents - order.feeCents;
    if (net <= 0) continue;

    const item: PendingReleaseHold = {
      orderId: order.id,
      orderCode: order.code,
      listingTitle: order.listing.title,
      netCents: net,
      releaseAt: hold?.releaseAt?.toISOString() ?? null,
      status: order.status,
    };
    holds.push(item);

    if (order.status === "DISPUTED") {
      inDisputeCents += net;
      continue;
    }

    if (hold?.releaseAt && hold.releaseAt.getTime() <= cutoff.getTime()) {
      releasesTodayCents += net;
    } else {
      releasesUpcomingCents += net;
    }
  }

  const totalCents =
    releasesTodayCents + releasesUpcomingCents + inDisputeCents;

  return {
    totalCents,
    releasesTodayCents,
    releasesUpcomingCents,
    inDisputeCents,
    holds: holds.slice(0, 8),
  };
}

export async function loadWalletSummary(tx: Tx, userId: string) {
  const [last, entries, pendingPayoutAgg, pendingRelease] = await Promise.all([
    tx.walletLedger.findFirst({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    tx.walletLedger.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: {
        id: true,
        type: true,
        amountCents: true,
        balanceAfter: true,
        description: true,
        orderId: true,
        createdAt: true,
        order: {
          select: {
            code: true,
            listing: { select: { title: true } },
          },
        },
      },
    }),
    tx.payout.aggregate({
      where: { userId, status: "REQUESTED" },
      _sum: { amountCents: true },
    }),
    computePendingReleaseBreakdown(tx, userId),
  ]);

  return {
    balanceCents: last?.balanceAfter ?? 0,
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      amountCents: entry.amountCents,
      balanceAfter: entry.balanceAfter,
      description: entry.description,
      orderId: entry.orderId,
      orderCode: entry.order?.code ?? null,
      listingTitle: entry.order?.listing?.title ?? null,
      createdAt: entry.createdAt.toISOString(),
    })),
    pendingPayoutCents: pendingPayoutAgg._sum.amountCents ?? 0,
    pendingRelease,
  };
}
