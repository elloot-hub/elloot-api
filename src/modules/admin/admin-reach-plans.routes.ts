import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";

export const adminReachPlansRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

function serialize(row: {
  id: string;
  code: string;
  title: string;
  description: string | null;
  feeBps: number;
  priority: number;
  barLevel: number;
  recommended: boolean;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    feeBps: row.feeBps,
    feePercent: Math.round((row.feeBps / 100) * 100) / 100,
    priority: row.priority,
    barLevel: row.barLevel,
    recommended: row.recommended,
    active: row.active,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const createSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(CODE_RE)),
  title: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  feeBps: z.number().int().min(0).max(5000),
  priority: z.number().int().min(0).max(10_000).optional().default(0),
  barLevel: z.number().int().min(1).max(4).optional().default(1),
  recommended: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  feeBps: z.number().int().min(0).max(5000).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  barLevel: z.number().int().min(1).max(4).optional(),
  recommended: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

adminReachPlansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const items = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.reachPlan.findMany({
        orderBy: [{ sortOrder: "asc" }, { feeBps: "asc" }],
      });
      return rows.map(serialize);
    });
    res.json({ items });
  }),
);

adminReachPlansRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const actor = actorOf(req);
    const title = sanitizeUserText(body.title, 80);
    const description =
      body.description != null
        ? sanitizeUserText(body.description, 500) || null
        : null;

    const item = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.reachPlan.findUnique({
        where: { code: body.code },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(409, "Código já em uso", "CONFLICT");
      }

      if (body.recommended) {
        await tx.reachPlan.updateMany({
          data: { recommended: false },
        });
      }

      const max = await tx.reachPlan.aggregate({ _max: { sortOrder: true } });
      const created = await tx.reachPlan.create({
        data: {
          code: body.code,
          title,
          description,
          feeBps: body.feeBps,
          priority: body.priority,
          barLevel: body.barLevel,
          recommended: body.recommended,
          active: body.active,
          sortOrder: body.sortOrder ?? (max._max.sortOrder ?? -1) + 1,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "reach_plan.created",
          entityType: "ReachPlan",
          entityId: created.id,
          meta: { code: created.code, feeBps: created.feeBps },
        },
      });

      return serialize(created);
    });

    res.status(201).json({ item });
  }),
);

adminReachPlansRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const body = updateSchema.parse(req.body);
    const actor = actorOf(req);

    const item = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.reachPlan.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError(404, "Plano não encontrado", "NOT_FOUND");
      }

      if (body.recommended === true) {
        await tx.reachPlan.updateMany({
          where: { id: { not: id } },
          data: { recommended: false },
        });
      }

      const updated = await tx.reachPlan.update({
        where: { id },
        data: {
          ...(body.title !== undefined
            ? { title: sanitizeUserText(body.title, 80) }
            : {}),
          ...(body.description !== undefined
            ? {
                description:
                  body.description != null
                    ? sanitizeUserText(body.description, 500) || null
                    : null,
              }
            : {}),
          ...(body.feeBps !== undefined ? { feeBps: body.feeBps } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.barLevel !== undefined ? { barLevel: body.barLevel } : {}),
          ...(body.recommended !== undefined
            ? { recommended: body.recommended }
            : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "reach_plan.updated",
          entityType: "ReachPlan",
          entityId: id,
          meta: body,
        },
      });

      return serialize(updated);
    });

    res.json({ item });
  }),
);

const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
});

adminReachPlansRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    const body = reorderSchema.parse(req.body);
    const actor = actorOf(req);

    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.reachPlan.findMany({
        where: { id: { in: body.ids } },
        select: { id: true },
      });
      if (existing.length !== body.ids.length) {
        throw new AppError(400, "ID inválido", "INVALID_REACH_PLAN");
      }

      await Promise.all(
        body.ids.map((planId, index) =>
          tx.reachPlan.update({
            where: { id: planId },
            data: { sortOrder: index },
          }),
        ),
      );

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "reach_plan.reordered",
          entityType: "ReachPlan",
          entityId: null,
          meta: { ids: body.ids },
        },
      });
    });

    res.json({ ok: true });
  }),
);

adminReachPlansRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.reachPlan.findUnique({
        where: { id },
        select: { id: true, code: true },
      });
      if (!existing) {
        throw new AppError(404, "Plano não encontrado", "NOT_FOUND");
      }

      const inUse = await tx.listing.count({ where: { reachPlanId: id } });
      if (inUse > 0) {
        await tx.reachPlan.update({
          where: { id },
          data: { active: false },
        });
      } else {
        await tx.reachPlan.delete({ where: { id } });
      }

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: inUse > 0 ? "reach_plan.deactivated" : "reach_plan.deleted",
          entityType: "ReachPlan",
          entityId: id,
          meta: { code: existing.code, inUse },
        },
      });
    });

    res.json({ ok: true });
  }),
);
