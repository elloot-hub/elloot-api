import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { invalidateAdminAuthCache } from "../../middleware/admin-auth";
import { invalidateAuthUserCache } from "../../middleware/auth";
import { notifyUser } from "../conversations/notifications.notify";
import { serializeAdminKycSubmission } from "./admin-kyc";

export const adminUsersRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  role: z.string().trim().max(80).optional(),
  kyc: z.string().trim().max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const ROLE_VALUES = ["BUYER", "SELLER", "ADMIN"] as const;
const KYC_VALUES = ["NONE", "PENDING", "APPROVED", "REJECTED"] as const;

function parseCsvEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (!raw) return undefined;
  const set = new Set(allowed);
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is T => set.has(v as T));
  return values.length ? values : undefined;
}

const kycSchema = z.object({
  kycStatus: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().min(5).max(1000),
});

const userListSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  kycStatus: true,
  lastSeenAt: true,
  emailVerifiedAt: true,
  reputationScore: true,
  createdAt: true,
} as const;

function serializeUser(row: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  kycStatus: string;
  lastSeenAt: Date | null;
  emailVerifiedAt: Date | null;
  reputationScore: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    role: row.role,
    kycStatus: row.kycStatus,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
    reputationScore: row.reputationScore,
    createdAt: row.createdAt.toISOString(),
  };
}

adminUsersRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const grouped = await tx.user.groupBy({
        by: ["role", "kycStatus"],
        _count: { _all: true },
      });

      const stats = {
        total: 0,
        buyers: 0,
        sellers: 0,
        admins: 0,
        kycPending: 0,
        kycApproved: 0,
        kycRejected: 0,
        kycPendingOver24h: 0,
      };

      for (const row of grouped) {
        stats.total += row._count._all;
        if (row.role === "BUYER") stats.buyers += row._count._all;
        if (row.role === "SELLER") stats.sellers += row._count._all;
        if (row.role === "ADMIN") stats.admins += row._count._all;
        if (row.kycStatus === "PENDING") stats.kycPending += row._count._all;
        if (row.kycStatus === "APPROVED") stats.kycApproved += row._count._all;
        if (row.kycStatus === "REJECTED") stats.kycRejected += row._count._all;
      }

      const cutoff24h = new Date(Date.now() - 24 * 3_600_000);
      stats.kycPendingOver24h = await tx.kycSubmission.count({
        where: { status: "PENDING", createdAt: { lte: cutoff24h } },
      });

      return stats;
    });
    res.json({ stats });
  }),
);

adminUsersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();
    const roles = parseCsvEnum(query.role, ROLE_VALUES);
    const kycs = parseCsvEnum(query.kyc, KYC_VALUES);

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.user.findMany({
        where: {
          ...(roles ? { role: { in: roles } } : {}),
          ...(kycs ? { kycStatus: { in: kycs } } : {}),
          ...(query.from || query.to
            ? {
                createdAt: {
                  ...(query.from ? { gte: new Date(query.from) } : {}),
                  ...(query.to ? { lte: new Date(query.to) } : {}),
                },
              }
            : {}),
          ...(q
            ? {
                OR: [
                  { email: { contains: q, mode: "insensitive" } },
                  { name: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: query.take + 1,
        select: userListSelect,
      });

      const hasMore = rows.length > query.take;
      const items = hasMore ? rows.slice(0, query.take) : rows;

      return {
        items: items.map(serializeUser),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

const kycQueueQuerySchema = z.object({
  status: z
    .enum(["PENDING", "APPROVED", "REJECTED", "ALL"])
    .optional()
    .default("PENDING"),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["oldest", "newest"]).optional().default("oldest"),
  take: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().optional(),
});

/** KYC submissions with document preview URLs (signed when private). */
adminUsersRouter.get(
  "/kyc-queue",
  asyncHandler(async (req, res) => {
    const query = kycQueueQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const orderBy =
        query.sort === "newest"
          ? ([{ createdAt: "desc" as const }, { id: "desc" as const }] as const)
          : ([{ createdAt: "asc" as const }, { id: "asc" as const }] as const);

      const rows = await tx.kycSubmission.findMany({
        where: {
          ...(query.status !== "ALL" ? { status: query.status } : {}),
          ...(q
            ? {
                OR: [
                  { id: { contains: q, mode: "insensitive" } },
                  { fullName: { contains: q, mode: "insensitive" } },
                  { documentNumber: { contains: q, mode: "insensitive" } },
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
        take: query.take + 1,
        ...(query.cursor
          ? { cursor: { id: query.cursor }, skip: 1 }
          : {}),
        include: {
          user: { select: userListSelect },
        },
      });

      const hasMore = rows.length > query.take;
      const page = hasMore ? rows.slice(0, query.take) : rows;

      const items = await Promise.all(
        page.map(async (row) => {
          const { user, ...submission } = row;
          const ageHours = Math.max(
            0,
            (Date.now() - row.createdAt.getTime()) / 3_600_000,
          );
          return {
            user: serializeUser(user),
            submission: await serializeAdminKycSubmission(tx, submission),
            ageHours,
          };
        }),
      );

      return {
        items,
        nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

/** Lightweight profile card for hover previews (chats, orders, etc.). */
adminUsersRouter.get(
  "/:id/card",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const card = await withRlsTransaction({ actor }, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          username: true,
          avatarUrl: true,
          kycStatus: true,
          createdAt: true,
        },
      });
      if (!user) return null;

      const [salesCount, ratings] = await Promise.all([
        tx.order.count({ where: { sellerId: id, status: "COMPLETED" } }),
        tx.review.findMany({
          where: { sellerId: id },
          select: { rating: true },
        }),
      ]);

      let ratingAvg: number | null = null;
      const ratingCount = ratings.length;
      if (ratingCount > 0) {
        const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
        ratingAvg = Math.round((sum / ratingCount) * 10) / 10;
      }

      return {
        id: user.id,
        name: user.name?.trim() || user.username || "Usuário",
        username: user.username,
        avatarUrl: user.avatarUrl,
        verified: user.kycStatus === "APPROVED",
        salesCount,
        ratingAvg,
        ratingCount,
        memberSince: user.createdAt.toISOString(),
      };
    });

    if (!card) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }

    res.json({ card });
  }),
);

adminUsersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const detail = await withRlsTransaction({ actor }, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id },
        select: {
          ...userListSelect,
          phone: true,
          phoneVerifiedAt: true,
          pixKey: true,
          accounts: {
            select: { provider: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      });
      if (!user) return null;

      const [
        listingsCount,
        ordersAsBuyer,
        ordersAsSeller,
        disputesOpened,
        payoutsRequested,
        latestKyc,
      ] = await Promise.all([
        tx.listing.count({ where: { sellerId: id } }),
        tx.order.count({ where: { buyerId: id } }),
        tx.order.count({ where: { sellerId: id } }),
        tx.dispute.count({ where: { openedById: id } }),
        tx.payout.count({ where: { userId: id } }),
        tx.kycSubmission.findFirst({
          where: { userId: id },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      const recentListings = await tx.listing.findMany({
        where: { sellerId: id },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          title: true,
          status: true,
          priceCents: true,
          createdAt: true,
        },
      });

      const recentOrders = await tx.order.findMany({
        where: { OR: [{ buyerId: id }, { sellerId: id }] },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          status: true,
          amountCents: true,
          buyerId: true,
          sellerId: true,
          createdAt: true,
          listing: { select: { title: true } },
        },
      });

      return {
        user: {
          ...serializeUser(user),
          phone: user.phone,
          phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
          pixKeyMasked: maskPixKey(user.pixKey),
          accounts: user.accounts.map((a) => ({
            provider: a.provider,
            createdAt: a.createdAt.toISOString(),
          })),
        },
        counts: {
          listings: listingsCount,
          ordersAsBuyer,
          ordersAsSeller,
          disputesOpened,
          payoutsRequested,
        },
        kycSubmission: latestKyc
          ? await serializeAdminKycSubmission(tx, latestKyc)
          : null,
        recentListings: recentListings.map((l) => ({
          ...l,
          createdAt: l.createdAt.toISOString(),
        })),
        recentOrders: recentOrders.map((o) => ({
          ...o,
          createdAt: o.createdAt.toISOString(),
          side: o.buyerId === id ? "buyer" : "seller",
        })),
      };
    });

    if (!detail) {
      throw new AppError(404, "User not found", "USER_NOT_FOUND");
    }

    res.json(detail);
  }),
);

adminUsersRouter.post(
  "/:id/kyc",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const body = kycSchema.parse(req.body);
    const actor = actorOf(req);
    const note = sanitizeUserText(body.note, 1000);

    const user = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.user.findUnique({
        where: { id },
        select: { id: true, kycStatus: true, role: true },
      });
      if (!existing) {
        throw new AppError(404, "User not found", "USER_NOT_FOUND");
      }

      const updated = await tx.user.update({
        where: { id },
        data: { kycStatus: body.kycStatus },
        select: userListSelect,
      });

      const latest = await tx.kycSubmission.findFirst({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true },
      });
      if (latest && latest.status === "PENDING") {
        await tx.kycSubmission.update({
          where: { id: latest.id },
          data: {
            status: body.kycStatus,
            reviewNote: note,
            reviewedAt: new Date(),
            reviewedById: actor.id,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action:
            body.kycStatus === "APPROVED" ? "kyc.approved" : "kyc.rejected",
          entityType: "User",
          entityId: id,
          meta: { from: existing.kycStatus, to: body.kycStatus, note },
        },
      });

      return serializeUser(updated);
    });

    invalidateAuthUserCache(id);
    invalidateAdminAuthCache(id);

    await notifyUser({
      userId: id,
      type: body.kycStatus === "APPROVED" ? "KYC.APPROVED" : "KYC.REJECTED",
      title:
        body.kycStatus === "APPROVED"
          ? "Documentos aprovados"
          : "Verificação recusada",
      body:
        body.kycStatus === "APPROVED"
          ? "Sua identidade foi confirmada. Os saques via PIX estão liberados."
          : note,
      href: "/dashboard/verification",
    });

    res.json({ user });
  }),
);

function maskPixKey(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "••••";
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-3)}`;
}
