import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";

export const adminAuditRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(80).optional(),
  actorId: z.string().trim().max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(30),
  cursor: z.string().optional(),
});

const auditSelect = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  meta: true,
  createdAt: true,
  actor: {
    select: { id: true, email: true, name: true, role: true },
  },
} as const;

function serializeAudit(row: {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  meta: unknown;
  createdAt: Date;
  actor: {
    id: string;
    email: string;
    name: string | null;
    role: string;
  } | null;
}) {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    meta: row.meta ?? null,
    createdAt: row.createdAt.toISOString(),
    actor: row.actor
      ? {
          id: row.actor.id,
          email: row.actor.email,
          name: row.actor.name,
          role: row.actor.role,
        }
      : null,
  };
}

adminAuditRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [total, last24h, topActions] = await Promise.all([
        tx.auditLog.count(),
        tx.auditLog.count({ where: { createdAt: { gte: since24h } } }),
        tx.auditLog.groupBy({
          by: ["action"],
          _count: { _all: true },
          orderBy: { _count: { action: "desc" } },
          take: 12,
        }),
      ]);

      return {
        total,
        last24h,
        topActions: topActions.map((row) => ({
          action: row.action,
          count: row._count._all,
        })),
      };
    });

    res.json({ stats });
  }),
);

adminAuditRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: {
          ...(query.action ? { action: query.action } : {}),
          ...(query.entityType ? { entityType: query.entityType } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.actorId ? { actorId: query.actorId } : {}),
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
                  { action: { contains: q, mode: "insensitive" } },
                  { entityType: { contains: q, mode: "insensitive" } },
                  { entityId: { contains: q, mode: "insensitive" } },
                  {
                    actor: {
                      email: { contains: q, mode: "insensitive" },
                    },
                  },
                  {
                    actor: {
                      name: { contains: q, mode: "insensitive" },
                    },
                  },
                ],
              }
            : {}),
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: query.take + 1,
        select: auditSelect,
      });

      const hasMore = rows.length > query.take;
      const items = hasMore ? rows.slice(0, query.take) : rows;

      return {
        items: items.map(serializeAudit),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

adminAuditRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const entry = await withRlsTransaction({ actor }, async (tx) => {
      const row = await tx.auditLog.findUnique({
        where: { id },
        select: auditSelect,
      });
      return row ? serializeAudit(row) : null;
    });

    if (!entry) {
      throw new AppError(404, "Audit entry not found", "AUDIT_NOT_FOUND");
    }

    res.json({ entry });
  }),
);
