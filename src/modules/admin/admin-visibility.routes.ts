import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { loadVisibilityAdminStats } from "../visibility/visibility.service";
import { invalidateHomeSectionsCache } from "../home/home.cache";

export const adminVisibilityRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const CODE_RE = /^[a-z][a-z0-9-]{1,62}$/;

function slugifyCode(input: string) {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "produto";
}

const productCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().regex(CODE_RE).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  durationHours: z.number().int().min(1).max(24 * 365),
  scope: z.enum(["GLOBAL", "CATEGORY"]).optional().default("GLOBAL"),
  categoryId: z.string().min(1).nullable().optional(),
  maxActiveSlots: z.number().int().min(1).max(10_000).nullable().optional(),
  queueEnabled: z.boolean().optional().default(true),
  priority: z.number().int().min(0).max(10_000).optional().default(0),
  badgeLabel: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().optional().default(true),
  sortOrder: z.number().int().min(0).max(10_000).optional().default(0),
});

const productUpdateSchema = productCreateSchema.partial();

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
  queueEnabled: boolean;
  priority: number;
  badgeLabel: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slugPath: string } | null;
  _count?: { placements: number };
  queuedCount?: number;
}) {
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
    maxActiveSlots: row.maxActiveSlots,
    queueEnabled: row.queueEnabled,
    priority: row.priority,
    badgeLabel: row.badgeLabel,
    active: row.active,
    sortOrder: row.sortOrder,
    activePlacements: row._count?.placements ?? 0,
    queuedCount: row.queuedCount ?? 0,
    fillRate:
      row.maxActiveSlots == null || row.maxActiveSlots <= 0
        ? null
        : Math.min(1, (row._count?.placements ?? 0) / row.maxActiveSlots),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

adminVisibilityRouter.get(
  "/products",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const includeInactive = req.query.includeInactive === "1";
    const items = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.visibilityProduct.findMany({
        where: includeInactive ? undefined : { active: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        include: {
          category: { select: { id: true, name: true, slugPath: true } },
          _count: {
            select: {
              placements: { where: { status: "ACTIVE" } },
            },
          },
        },
      });
      return Promise.all(
        rows.map(async (row) => {
          const queuedCount = await tx.listingPlacement.count({
            where: { productId: row.id, status: "PENDING" },
          });
          return serializeProduct({ ...row, queuedCount });
        }),
      );
    });
    res.json({ items });
  }),
);

adminVisibilityRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const stats = await withRlsTransaction({ actor }, (tx) =>
      loadVisibilityAdminStats(tx),
    );
    res.json(stats);
  }),
);

adminVisibilityRouter.post(
  "/products",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = productCreateSchema.parse(req.body);
    const name = sanitizeUserText(body.name, 80);
    const code = body.code ?? slugifyCode(name);
    const description =
      body.description === undefined || body.description === null
        ? null
        : sanitizeUserText(body.description, 2000);
    const badgeLabel =
      body.badgeLabel === undefined || body.badgeLabel === null
        ? null
        : sanitizeUserText(body.badgeLabel, 40);

    if (body.scope === "CATEGORY" && !body.categoryId) {
      throw new AppError(
        400,
        "Produtos com escopo CATEGORY precisam de categoryId",
        "VISIBILITY_CATEGORY_REQUIRED",
      );
    }

    const product = await withRlsTransaction({ actor }, async (tx) => {
      if (body.categoryId) {
        const cat = await tx.category.findFirst({
          where: { id: body.categoryId },
          select: { id: true },
        });
        if (!cat) {
          throw new AppError(404, "Categoria não encontrada", "NOT_FOUND");
        }
      }
      const exists = await tx.visibilityProduct.findUnique({
        where: { code },
        select: { id: true },
      });
      if (exists) {
        throw new AppError(409, "Código já em uso", "VISIBILITY_CODE_TAKEN");
      }
      const created = await tx.visibilityProduct.create({
        data: {
          name,
          code,
          description,
          priceCents: body.priceCents,
          durationHours: body.durationHours,
          scope: body.scope,
          categoryId: body.scope === "CATEGORY" ? body.categoryId! : null,
          maxActiveSlots: body.maxActiveSlots ?? null,
          queueEnabled: body.queueEnabled ?? true,
          priority: body.priority ?? 0,
          badgeLabel,
          active: body.active ?? true,
          sortOrder: body.sortOrder ?? 0,
        },
        include: {
          category: { select: { id: true, name: true, slugPath: true } },
          _count: { select: { placements: true } },
        },
      });
      return serializeProduct(created);
    });

    res.status(201).json({ product });
    void invalidateHomeSectionsCache();
  }),
);

adminVisibilityRouter.patch(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = routeParam(req.params.id);
    const body = productUpdateSchema.parse(req.body);

    const product = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.visibilityProduct.findFirst({
        where: { id },
      });
      if (!existing) {
        throw new AppError(404, "Produto não encontrado", "NOT_FOUND");
      }

      const nextScope = body.scope ?? existing.scope;
      const nextCategoryId =
        body.categoryId !== undefined ? body.categoryId : existing.categoryId;
      if (nextScope === "CATEGORY" && !nextCategoryId) {
        throw new AppError(
          400,
          "Produtos com escopo CATEGORY precisam de categoryId",
          "VISIBILITY_CATEGORY_REQUIRED",
        );
      }

      if (body.code && body.code !== existing.code) {
        const taken = await tx.visibilityProduct.findUnique({
          where: { code: body.code },
          select: { id: true },
        });
        if (taken) {
          throw new AppError(409, "Código já em uso", "VISIBILITY_CODE_TAKEN");
        }
      }

      if (nextCategoryId) {
        const cat = await tx.category.findFirst({
          where: { id: nextCategoryId },
          select: { id: true },
        });
        if (!cat) {
          throw new AppError(404, "Categoria não encontrada", "NOT_FOUND");
        }
      }

      const updated = await tx.visibilityProduct.update({
        where: { id },
        data: {
          name:
            body.name !== undefined
              ? sanitizeUserText(body.name, 80)
              : undefined,
          code: body.code,
          description:
            body.description === undefined
              ? undefined
              : body.description === null
                ? null
                : sanitizeUserText(body.description, 2000),
          priceCents: body.priceCents,
          durationHours: body.durationHours,
          scope: body.scope,
          categoryId: nextScope === "CATEGORY" ? nextCategoryId : null,
          maxActiveSlots: body.maxActiveSlots,
          queueEnabled: body.queueEnabled,
          priority: body.priority,
          badgeLabel:
            body.badgeLabel === undefined
              ? undefined
              : body.badgeLabel === null
                ? null
                : sanitizeUserText(body.badgeLabel, 40),
          active: body.active,
          sortOrder: body.sortOrder,
        },
        include: {
          category: { select: { id: true, name: true, slugPath: true } },
          _count: {
            select: { placements: { where: { status: "ACTIVE" } } },
          },
        },
      });
      return serializeProduct(updated);
    });

    res.json({ product });
    void invalidateHomeSectionsCache();
  }),
);

adminVisibilityRouter.delete(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = routeParam(req.params.id);
    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.visibilityProduct.findFirst({
        where: { id },
        include: {
          _count: {
            select: { placements: { where: { status: { in: ["ACTIVE", "PENDING"] } } } },
          },
        },
      });
      if (!existing) {
        throw new AppError(404, "Produto não encontrado", "NOT_FOUND");
      }
      if (existing._count.placements > 0) {
        // Soft-disable instead of hard delete when in use.
        await tx.visibilityProduct.update({
          where: { id },
          data: { active: false },
        });
        return;
      }
      const linked = await tx.homeSection.count({
        where: { productIds: { has: id } },
      });
      if (linked > 0) {
        await tx.visibilityProduct.update({
          where: { id },
          data: { active: false },
        });
        return;
      }
      await tx.visibilityProduct.delete({ where: { id } });
    });
    res.json({ ok: true as const });
    void invalidateHomeSectionsCache();
  }),
);
