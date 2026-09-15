import type { Prisma } from "@prisma/client";
import type { RlsActor } from "../../databases";
import { computePendingReleaseBreakdown } from "../wallet/wallet.service";

type Tx = Prisma.TransactionClient;

export type DashboardActionKind =
  | "PAY_ORDER"
  | "DELIVER_ORDER"
  | "CONFIRM_ORDER"
  | "VIEW_DISPUTE"
  | "ANSWER_QUESTION"
  | "FIX_LISTING";

export type DashboardActionUrgency = "high" | "medium" | "low";

export type DashboardActionItem = {
  id: string;
  kind: DashboardActionKind;
  role: "buyer" | "seller";
  title: string;
  meta: string;
  href: string;
  ctaLabel: string;
  urgency: DashboardActionUrgency;
  expiresAt: string | null;
  sortAt: string;
};

export type DashboardNavCounts = {
  notifications: number;
  purchases: number;
  sales: number;
  messages: number;
  questionsReceived: number;
  listingsAttention: number;
};

export type DashboardSummaryStats = {
  balanceCents: number;
  pendingReleaseCents: number;
  releasesTodayCents: number;
  releasesUpcomingCents: number;
  inDisputeCents: number;
  pendingPayoutCents: number;
  listingsTotal: number;
  activeListings: number;
  listingsPendingReview: number;
  listingsRejected: number;
  salesPending: number;
  salesCompleted: number;
  purchasesOpen: number;
  purchasesCompleted: number;
  conversations: number;
  kycStatus: string;
};

export type DashboardSummary = {
  stats: DashboardSummaryStats;
  counts: DashboardNavCounts;
  actions: DashboardActionItem[];
};

const orderActionSelect = {
  id: true,
  code: true,
  status: true,
  amountCents: true,
  feeCents: true,
  buyerId: true,
  sellerId: true,
  expiresAt: true,
  updatedAt: true,
  listing: { select: { id: true, title: true } },
} as const;

function urgencyScore(item: DashboardActionItem): number {
  if (item.urgency === "high") return 3;
  if (item.urgency === "medium") return 2;
  return 1;
}

function sortActions(items: DashboardActionItem[]): DashboardActionItem[] {
  return [...items].sort((a, b) => {
    const score = urgencyScore(b) - urgencyScore(a);
    if (score !== 0) return score;
    const aExp = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
    const bExp = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
    if (aExp !== bExp) return aExp - bExp;
    return new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime();
  });
}

function formatOrderHref(order: { code: string }) {
  return `/orders/${order.code}`;
}

function minutesUntil(iso: string | Date | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.round(ms / 60_000));
}

function payMeta(expiresAt: Date | null): string {
  const mins = minutesUntil(expiresAt);
  if (mins == null) return "Comprador · aguardando pagamento";
  if (mins <= 60) return `Comprador · expira em ${mins} min`;
  const hours = Math.round(mins / 60);
  return `Comprador · expira em ${hours}h`;
}

export async function loadDashboardSummary(
  tx: Tx,
  actor: RlsActor,
): Promise<DashboardSummary> {
  const userId = actor.id;

  const [
    user,
    walletLast,
    listingsGrouped,
    buyerActionOrders,
    sellerPaidOrders,
    buyerDeliveredOrders,
    disputedOrders,
    unansweredQuestionsCount,
    unansweredQuestions,
    rejectedListings,
    unreadNotifications,
    unreadMessages,
    conversationsCount,
    pendingPayoutAgg,
    salesCompleted,
    purchasesOpen,
    buyerAttentionCount,
    salesDeliverPendingCount,
    salesPendingCount,
    purchasesCompleted,
  ] = await Promise.all([
    tx.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true },
    }),
    tx.walletLedger.findFirst({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { balanceAfter: true },
    }),
    tx.listing.groupBy({
      by: ["status"],
      where: { sellerId: userId },
      _count: { _all: true },
    }),
    tx.order.findMany({
      where: { buyerId: userId, status: "PENDING_PAYMENT" },
      orderBy: [{ expiresAt: "asc" }, { createdAt: "desc" }],
      take: 8,
      select: orderActionSelect,
    }),
    tx.order.findMany({
      where: { sellerId: userId, status: "PAID" },
      orderBy: [{ paidAt: "asc" }, { createdAt: "desc" }],
      take: 8,
      select: orderActionSelect,
    }),
    tx.order.findMany({
      where: { buyerId: userId, status: "DELIVERED" },
      orderBy: [{ deliveredAt: "desc" }, { updatedAt: "desc" }],
      take: 8,
      select: orderActionSelect,
    }),
    tx.order.findMany({
      where: {
        status: "DISPUTED",
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: orderActionSelect,
    }),
    tx.listingQuestion.count({
      where: {
        moderated: false,
        answer: null,
        listing: { sellerId: userId },
      },
    }),
    tx.listingQuestion.findMany({
      where: {
        moderated: false,
        answer: null,
        listing: { sellerId: userId },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        createdAt: true,
        listing: { select: { id: true, title: true } },
      },
    }),
    tx.listing.findMany({
      where: { sellerId: userId, status: "REJECTED" },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, title: true, updatedAt: true },
    }),
    tx.notification.count({
      where: { userId, readAt: null },
    }),
    tx.message.count({
      where: {
        readAt: null,
        senderId: { not: userId },
        conversation: {
          order: {
            OR: [{ buyerId: userId }, { sellerId: userId }],
          },
        },
      },
    }),
    tx.conversation.count({
      where: {
        order: {
          OR: [{ buyerId: userId }, { sellerId: userId }],
        },
      },
    }),
    tx.payout.aggregate({
      where: { userId, status: "REQUESTED" },
      _sum: { amountCents: true },
    }),
    tx.order.count({
      where: { sellerId: userId, status: "COMPLETED" },
    }),
    tx.order.count({
      where: {
        buyerId: userId,
        status: { in: ["PENDING_PAYMENT", "PAID", "DELIVERED", "DISPUTED"] },
      },
    }),
    tx.order.count({
      where: {
        buyerId: userId,
        status: { in: ["PENDING_PAYMENT", "DELIVERED", "DISPUTED"] },
      },
    }),
    tx.order.count({
      where: { sellerId: userId, status: "PAID" },
    }),
    tx.order.count({
      where: {
        sellerId: userId,
        status: { in: ["PAID", "DELIVERED"] },
      },
    }),
    tx.order.count({
      where: { buyerId: userId, status: "COMPLETED" },
    }),
  ]);

  const listingCounts = Object.fromEntries(
    listingsGrouped.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const listingsTotal = listingsGrouped.reduce(
    (sum, row) => sum + row._count._all,
    0,
  );
  const activeListings = listingCounts.ACTIVE ?? 0;
  const listingsRejected = listingCounts.REJECTED ?? 0;
  const listingsPendingReview = listingCounts.PENDING_REVIEW ?? 0;
  const listingsAttention = listingsRejected + listingsPendingReview;

  const pendingRelease = await computePendingReleaseBreakdown(tx, userId);
  const pendingReleaseCents = pendingRelease.totalCents;

  const actions: DashboardActionItem[] = [];

  for (const order of buyerActionOrders) {
    const mins = minutesUntil(order.expiresAt);
    actions.push({
      id: `pay-${order.id}`,
      kind: "PAY_ORDER",
      role: "buyer",
      title: `Pagar PIX — ${order.listing.title}`,
      meta: payMeta(order.expiresAt),
      href: formatOrderHref(order),
      ctaLabel: "Pagar agora",
      urgency: mins != null && mins <= 60 ? "high" : "high",
      expiresAt: order.expiresAt?.toISOString() ?? null,
      sortAt: order.expiresAt?.toISOString() ?? order.updatedAt.toISOString(),
    });
  }

  for (const order of sellerPaidOrders) {
    actions.push({
      id: `deliver-${order.id}`,
      kind: "DELIVER_ORDER",
      role: "seller",
      title: `Entregar pedido — ${order.listing.title}`,
      meta: "Vendedor · aguardando entrega",
      href: formatOrderHref(order),
      ctaLabel: "Marcar entregue",
      urgency: "medium",
      expiresAt: null,
      sortAt: order.updatedAt.toISOString(),
    });
  }

  for (const order of buyerDeliveredOrders) {
    actions.push({
      id: `confirm-${order.id}`,
      kind: "CONFIRM_ORDER",
      role: "buyer",
      title: `Confirmar recebimento — ${order.listing.title}`,
      meta: "Comprador · vendedor marcou entrega",
      href: formatOrderHref(order),
      ctaLabel: "Confirmar",
      urgency: "medium",
      expiresAt: null,
      sortAt: order.updatedAt.toISOString(),
    });
  }

  for (const order of disputedOrders) {
    const role = order.buyerId === userId ? "buyer" : "seller";
    actions.push({
      id: `dispute-${order.id}`,
      kind: "VIEW_DISPUTE",
      role,
      title: `Disputa aberta — ${order.listing.title}`,
      meta: role === "buyer" ? "Comprador · disputa em andamento" : "Vendedor · disputa em andamento",
      href: formatOrderHref(order),
      ctaLabel: "Ver disputa",
      urgency: "high",
      expiresAt: null,
      sortAt: order.updatedAt.toISOString(),
    });
  }

  for (const question of unansweredQuestions) {
    actions.push({
      id: `question-${question.id}`,
      kind: "ANSWER_QUESTION",
      role: "seller",
      title: `Responder pergunta — ${question.listing.title}`,
      meta: "Vendedor · pergunta sem resposta",
      href: "/dashboard/questions/received",
      ctaLabel: "Responder",
      urgency: "low",
      expiresAt: null,
      sortAt: question.createdAt.toISOString(),
    });
  }

  for (const listing of rejectedListings) {
    actions.push({
      id: `listing-${listing.id}`,
      kind: "FIX_LISTING",
      role: "seller",
      title: `Corrigir anúncio — ${listing.title}`,
      meta: "Vendedor · anúncio rejeitado",
      href: `/dashboard/listings/${listing.id}/edit`,
      ctaLabel: "Corrigir",
      urgency: "low",
      expiresAt: null,
      sortAt: listing.updatedAt.toISOString(),
    });
  }

  return {
    stats: {
      balanceCents: walletLast?.balanceAfter ?? 0,
      pendingReleaseCents,
      releasesTodayCents: pendingRelease.releasesTodayCents,
      releasesUpcomingCents: pendingRelease.releasesUpcomingCents,
      inDisputeCents: pendingRelease.inDisputeCents,
      pendingPayoutCents: pendingPayoutAgg._sum.amountCents ?? 0,
      listingsTotal,
      activeListings,
      listingsPendingReview,
      listingsRejected,
      salesPending: salesPendingCount,
      salesCompleted,
      purchasesOpen,
      purchasesCompleted,
      conversations: conversationsCount,
      kycStatus: user?.kycStatus ?? "NONE",
    },
    counts: {
      notifications: unreadNotifications,
      purchases: buyerAttentionCount,
      sales: salesDeliverPendingCount,
      messages: unreadMessages,
      questionsReceived: unansweredQuestionsCount,
      listingsAttention,
    },
    actions: sortActions(actions).slice(0, 12),
  };
}
