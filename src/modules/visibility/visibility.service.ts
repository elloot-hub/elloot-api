import type { Prisma } from "@prisma/client";
import {
  creditWallet,
  lockWalletUser,
} from "../../databases";
import { AppError } from "../../lib/errors";
import { listingWhereByRef } from "../listings/listing-ref";
import { activePlacementWhere } from "./visibility.badges";
import {
  syncListingVisibilityBoost,
  syncListingVisibilityBoostMany,
} from "./visibility.boost";

type Tx = Prisma.TransactionClient;

function serializeProduct(row: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationHours: number;
  scope: string;
  categoryId: string | null;
  maxActiveSlots: number | null;
  queueEnabled?: boolean;
  priority: number;
  badgeLabel: string | null;
  active: boolean;
  sortOrder: number;
  category?: { id: string; name: string; slugPath: string } | null;
  slotsUsed?: number;
  queuedCount?: number;
}) {
  const max = row.maxActiveSlots;
  const used = row.slotsUsed ?? 0;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    priceCents: row.priceCents,
    durationHours: row.durationHours,
    scope: row.scope,
    categoryId: row.categoryId,
    category: row.category
      ? {
          id: row.category.id,
          name: row.category.name,
          slugPath: row.category.slugPath,
        }
      : null,
    maxActiveSlots: max,
    queueEnabled: row.queueEnabled ?? true,
    priority: row.priority,
    badgeLabel: row.badgeLabel,
    active: row.active,
    sortOrder: row.sortOrder,
    slotsUsed: used,
    queuedCount: row.queuedCount ?? 0,
    slotsAvailable: max == null ? null : Math.max(0, max - used),
    fillRate:
      max == null || max <= 0 ? null : Math.min(1, used / max),
  };
}

function serializePlacement(row: {
  id: string;
  listingId: string;
  productId: string;
  status: string;
  paidCents?: number;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  product?: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    priceCents: number;
    durationHours: number;
    scope: string;
    categoryId: string | null;
    maxActiveSlots: number | null;
    queueEnabled?: boolean;
    priority: number;
    badgeLabel: string | null;
    active: boolean;
    sortOrder: number;
  };
}) {
  return {
    id: row.id,
    listingId: row.listingId,
    productId: row.productId,
    status: row.status,
    paidCents: row.paidCents ?? 0,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    product: row.product ? serializeProduct(row.product) : undefined,
  };
}

async function countActiveSlots(tx: Tx, productId: string, now = new Date()) {
  return tx.listingPlacement.count({
    where: {
      productId,
      ...activePlacementWhere(now),
    },
  });
}

async function countQueued(tx: Tx, productId: string) {
  return tx.listingPlacement.count({
    where: { productId, status: "PENDING" },
  });
}

export async function listActiveVisibilityProducts(tx: Tx) {
  const now = new Date();
  const rows = await tx.visibilityProduct.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { priceCents: "asc" }],
    include: {
      category: { select: { id: true, name: true, slugPath: true } },
    },
  });

  return Promise.all(
    rows.map(async (row) => {
      const [slotsUsed, queuedCount] = await Promise.all([
        countActiveSlots(tx, row.id, now),
        countQueued(tx, row.id),
      ]);
      return serializeProduct({ ...row, slotsUsed, queuedCount });
    }),
  );
}

export async function listListingPlacements(tx: Tx, listingId: string) {
  const rows = await tx.listingPlacement.findMany({
    where: { listingId },
    orderBy: [{ createdAt: "desc" }],
    include: { product: true },
  });
  return rows.map(serializePlacement);
}

async function assertCategoryScope(
  tx: Tx,
  listingCategoryId: string,
  productCategoryId: string,
) {
  if (listingCategoryId === productCategoryId) return;

  const [listingCat, productCat] = await Promise.all([
    tx.category.findFirst({
      where: { id: listingCategoryId },
      select: { slugPath: true },
    }),
    tx.category.findFirst({
      where: { id: productCategoryId },
      select: { slugPath: true },
    }),
  ]);

  if (!listingCat || !productCat) {
    throw new AppError(
      400,
      "Produto de visibilidade incompatível com a categoria do anúncio",
      "VISIBILITY_CATEGORY_MISMATCH",
    );
  }

  const ok =
    listingCat.slugPath === productCat.slugPath ||
    listingCat.slugPath.startsWith(`${productCat.slugPath}/`);

  if (!ok) {
    throw new AppError(
      400,
      "Este produto só vale para outra categoria",
      "VISIBILITY_CATEGORY_MISMATCH",
    );
  }
}

export async function purchaseVisibilityWithWallet(
  tx: Tx,
  input: {
    actorId: string;
    listingRef: string;
    productId: string;
  },
) {
  const listing = await tx.listing.findFirst({
    where: {
      ...listingWhereByRef(input.listingRef),
      sellerId: input.actorId,
    },
    select: {
      id: true,
      status: true,
      categoryId: true,
      title: true,
    },
  });

  if (!listing) {
    throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
  }
  if (listing.status !== "ACTIVE") {
    throw new AppError(
      409,
      "Só anúncios ativos podem comprar visibilidade",
      "LISTING_NOT_ACTIVE",
    );
  }

  const product = await tx.visibilityProduct.findFirst({
    where: { id: input.productId, active: true },
  });
  if (!product) {
    throw new AppError(404, "Produto não encontrado", "PRODUCT_NOT_FOUND");
  }

  if (product.scope === "CATEGORY" && product.categoryId) {
    await assertCategoryScope(tx, listing.categoryId, product.categoryId);
  }

  const now = new Date();

  const existingActive = await tx.listingPlacement.findFirst({
    where: {
      listingId: listing.id,
      productId: product.id,
      ...activePlacementWhere(now),
    },
  });

  const existingQueued = await tx.listingPlacement.findFirst({
    where: {
      listingId: listing.id,
      productId: product.id,
      status: "PENDING",
    },
  });

  if (existingQueued && !existingActive) {
    throw new AppError(
      409,
      "Este anúncio já está na fila deste produto",
      "VISIBILITY_ALREADY_QUEUED",
    );
  }

  let enqueue = false;
  if (!existingActive && product.maxActiveSlots != null) {
    const activeCount = await countActiveSlots(tx, product.id, now);
    if (activeCount >= product.maxActiveSlots) {
      if (product.queueEnabled) {
        enqueue = true;
      } else {
        throw new AppError(
          409,
          "Slots esgotados para este produto",
          "VISIBILITY_SLOTS_FULL",
        );
      }
    }
  }

  await lockWalletUser(tx, input.actorId);
  const last = await tx.walletLedger.findFirst({
    where: { userId: input.actorId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const balanceCents = last?.balanceAfter ?? 0;

  if (product.priceCents > 0 && balanceCents < product.priceCents) {
    throw new AppError(
      402,
      "Saldo insuficiente na carteira",
      "INSUFFICIENT_BALANCE",
    );
  }

  if (product.priceCents > 0) {
    await creditWallet(tx, {
      userId: input.actorId,
      orderId: null,
      type: "ADJUSTMENT",
      amountCents: -product.priceCents,
      description: enqueue
        ? `Visibilidade (fila): ${product.name} — ${listing.title}`
        : `Visibilidade: ${product.name} — ${listing.title}`,
    });
  }

  const durationMs = product.durationHours * 60 * 60 * 1000;
  const nextBalance = balanceCents - product.priceCents;

  if (existingActive) {
    const base =
      existingActive.endsAt && existingActive.endsAt > now
        ? existingActive.endsAt
        : now;
    const endsAt = new Date(base.getTime() + durationMs);
    const updated = await tx.listingPlacement.update({
      where: { id: existingActive.id },
      data: {
        endsAt,
        paidCents: { increment: product.priceCents },
      },
      include: { product: true },
    });
    await syncListingVisibilityBoost(tx, listing.id, now);
    return {
      placement: serializePlacement(updated),
      extended: true as const,
      queued: false as const,
      balanceCents: nextBalance,
    };
  }

  if (enqueue) {
    const created = await tx.listingPlacement.create({
      data: {
        listingId: listing.id,
        productId: product.id,
        status: "PENDING",
        paidCents: product.priceCents,
        startsAt: null,
        endsAt: null,
      },
      include: { product: true },
    });
    return {
      placement: serializePlacement(created),
      extended: false as const,
      queued: true as const,
      balanceCents: nextBalance,
    };
  }

  const startsAt = now;
  const endsAt = new Date(now.getTime() + durationMs);
  const created = await tx.listingPlacement.create({
    data: {
      listingId: listing.id,
      productId: product.id,
      status: "ACTIVE",
      paidCents: product.priceCents,
      startsAt,
      endsAt,
    },
    include: { product: true },
  });
  await syncListingVisibilityBoost(tx, listing.id, now);

  return {
    placement: serializePlacement(created),
    extended: false as const,
    queued: false as const,
    balanceCents: nextBalance,
  };
}

export async function expireVisibilityPlacements(tx: Tx) {
  const now = new Date();
  const due = await tx.listingPlacement.findMany({
    where: {
      status: "ACTIVE",
      endsAt: { lte: now },
    },
    select: { id: true, listingId: true },
  });
  if (due.length === 0) {
    return { expiredPlacements: 0 };
  }

  await tx.listingPlacement.updateMany({
    where: { id: { in: due.map((row) => row.id) } },
    data: { status: "EXPIRED" },
  });
  await syncListingVisibilityBoostMany(
    tx,
    due.map((row) => row.listingId),
    now,
  );
  return { expiredPlacements: due.length };
}

/** Promote oldest PENDING placements into free slots. */
export async function promoteQueuedPlacements(tx: Tx) {
  const now = new Date();
  const products = await tx.visibilityProduct.findMany({
    where: {
      active: true,
      maxActiveSlots: { not: null },
    },
    select: {
      id: true,
      maxActiveSlots: true,
      durationHours: true,
    },
  });

  let promoted = 0;
  let cancelled = 0;

  for (const product of products) {
    const max = product.maxActiveSlots;
    if (max == null) continue;

    const activeCount = await countActiveSlots(tx, product.id, now);
    const free = max - activeCount;
    if (free <= 0) continue;

    const queued = await tx.listingPlacement.findMany({
      where: { productId: product.id, status: "PENDING" },
      orderBy: [{ createdAt: "asc" }],
      take: free * 2,
    });

    let remaining = free;
    for (const item of queued) {
      if (remaining <= 0) break;

      const listing = await tx.listing.findFirst({
        where: { id: item.listingId },
        select: { id: true, status: true },
      });

      if (!listing || listing.status !== "ACTIVE") {
        await tx.listingPlacement.update({
          where: { id: item.id },
          data: { status: "CANCELLED" },
        });
        cancelled += 1;
        continue;
      }

      const alreadyActive = await tx.listingPlacement.findFirst({
        where: {
          listingId: item.listingId,
          productId: product.id,
          ...activePlacementWhere(now),
          NOT: { id: item.id },
        },
        select: { id: true },
      });
      if (alreadyActive) {
        await tx.listingPlacement.update({
          where: { id: item.id },
          data: { status: "CANCELLED" },
        });
        cancelled += 1;
        continue;
      }

      const endsAt = new Date(now.getTime() + product.durationHours * 3600_000);
      await tx.listingPlacement.update({
        where: { id: item.id },
        data: {
          status: "ACTIVE",
          startsAt: now,
          endsAt,
        },
      });
      await syncListingVisibilityBoost(tx, item.listingId, now);
      promoted += 1;
      remaining -= 1;
    }
  }

  return { promoted, cancelled };
}

/**
 * Recomputes visibilityBoost for listings with active placements and
 * clears stale boosts. Safe to run on every job tick.
 */
export async function reconcileVisibilityBoosts(tx: Tx) {
  const now = new Date();
  const active = await tx.listingPlacement.findMany({
    where: {
      ...activePlacementWhere(now),
      product: { active: true },
    },
    select: { listingId: true },
  });
  const activeIds = [...new Set(active.map((row) => row.listingId))];
  await syncListingVisibilityBoostMany(tx, activeIds, now);

  await tx.listing.updateMany({
    where: {
      visibilityBoost: { gt: 0 },
      ...(activeIds.length > 0 ? { id: { notIn: activeIds } } : {}),
    },
    data: { visibilityBoost: 0 },
  });

  return { activeBoosted: activeIds.length };
}

export async function loadVisibilityAdminStats(tx: Tx) {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const products = await tx.visibilityProduct.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      active: true,
      maxActiveSlots: true,
      queueEnabled: true,
      priceCents: true,
    },
  });

  const productStats = await Promise.all(
    products.map(async (product) => {
      const [activeCount, queuedCount, revenueAgg] = await Promise.all([
        countActiveSlots(tx, product.id, now),
        countQueued(tx, product.id),
        tx.listingPlacement.aggregate({
          where: {
            productId: product.id,
            createdAt: { gte: since },
            status: { in: ["ACTIVE", "EXPIRED", "PENDING"] },
          },
          _sum: { paidCents: true },
        }),
      ]);
      const max = product.maxActiveSlots;
      return {
        id: product.id,
        code: product.code,
        name: product.name,
        active: product.active,
        maxActiveSlots: max,
        queueEnabled: product.queueEnabled,
        activeCount,
        queuedCount,
        fillRate: max == null || max <= 0 ? null : Math.min(1, activeCount / max),
        revenueCents30d: revenueAgg._sum.paidCents ?? 0,
      };
    }),
  );

  const [activePlacements, queuedPlacements, revenueAll] = await Promise.all([
    tx.listingPlacement.count({ where: activePlacementWhere(now) }),
    tx.listingPlacement.count({ where: { status: "PENDING" } }),
    tx.listingPlacement.aggregate({
      where: {
        createdAt: { gte: since },
        status: { in: ["ACTIVE", "EXPIRED", "PENDING"] },
      },
      _sum: { paidCents: true },
    }),
  ]);

  return {
    summary: {
      activePlacements,
      queuedPlacements,
      revenueCents30d: revenueAll._sum.paidCents ?? 0,
      productsActive: products.filter((p) => p.active).length,
      productsTotal: products.length,
    },
    products: productStats,
  };
}
