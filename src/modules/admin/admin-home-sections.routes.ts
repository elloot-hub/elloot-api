import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { invalidateHomeSectionsCache } from "../home/home.cache";

export const adminHomeSectionsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const sectionCreateSchema = z.object({
  title: z.string().trim().min(2).max(80),
  subtitle: z.string().trim().max(200).nullable().optional(),
  source: z.enum(["PLACEMENT", "CATEGORY", "METRIC", "MANUAL"]),
  layout: z.enum(["GRID", "CAROUSEL"]).optional().default("GRID"),
  productIds: z.array(z.string().min(1)).max(20).optional().default([]),
  categoryId: z.string().min(1).nullable().optional(),
  metric: z
    .enum(["RECENT", "BEST_SELLING", "MOST_FAVORITED", "MOST_VIEWED"])
    .nullable()
    .optional(),
  manualListingIds: z.array(z.string().min(1)).max(50).optional().default([]),
  itemLimit: z.number().int().min(1).max(48).optional().default(10),
  columns: z.number().int().min(2).max(8).optional().default(5),
  viewMoreHref: z.string().trim().max(300).nullable().optional(),
  viewMoreLabel: z.string().trim().max(40).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional().default(0),
  active: z.boolean().optional().default(true),
});

const sectionUpdateSchema = sectionCreateSchema.partial();

const reorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(100),
});

function serializeSection(row: {
  id: string;
  title: string;
  subtitle: string | null;
  source: string;
  layout: string;
  productIds: string[];
  categoryId: string | null;
  metric: string | null;
  manualListingIds: string[];
  itemLimit: number;
  columns: number;
  viewMoreHref: string | null;
  viewMoreLabel: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  category?: { id: string; name: string; slugPath: string } | null;
}) {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    source: row.source,
    layout: row.layout,
    productIds: row.productIds,
    categoryId: row.categoryId,
    category: row.category
      ? {
          id: row.category.id,
          name: row.category.name,
          slugPath: row.category.slugPath,
        }
      : null,
    metric: row.metric,
    manualListingIds: row.manualListingIds,
    itemLimit: row.itemLimit,
    columns: row.columns,
    viewMoreHref: row.viewMoreHref,
    viewMoreLabel: row.viewMoreLabel,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateSourceFields(input: {
  source: string;
  productIds: string[];
  categoryId: string | null | undefined;
  metric: string | null | undefined;
  manualListingIds: string[];
}) {
  if (input.source === "PLACEMENT" && input.productIds.length === 0) {
    throw new AppError(
      400,
      "Seção PLACEMENT precisa de ao menos um produto",
      "HOME_SECTION_PRODUCTS_REQUIRED",
    );
  }
  if (input.source === "CATEGORY" && !input.categoryId) {
    throw new AppError(
      400,
      "Seção CATEGORY precisa de categoryId",
      "HOME_SECTION_CATEGORY_REQUIRED",
    );
  }
  if (input.source === "METRIC" && !input.metric) {
    throw new AppError(
      400,
      "Seção METRIC precisa de metric",
      "HOME_SECTION_METRIC_REQUIRED",
    );
  }
  if (input.source === "MANUAL" && input.manualListingIds.length === 0) {
    throw new AppError(
      400,
      "Seção MANUAL precisa de anúncios",
      "HOME_SECTION_LISTINGS_REQUIRED",
    );
  }
}

adminHomeSectionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const includeInactive = req.query.includeInactive === "1";
    const items = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.homeSection.findMany({
        where: includeInactive ? undefined : { active: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: {
          category: { select: { id: true, name: true, slugPath: true } },
        },
      });
      return rows.map(serializeSection);
    });
    res.json({ items });
  }),
);

adminHomeSectionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = sectionCreateSchema.parse(req.body);
    const title = sanitizeUserText(body.title, 80);
    const subtitle =
      body.subtitle === undefined || body.subtitle === null
        ? null
        : sanitizeUserText(body.subtitle, 200);
    const productIds = body.productIds ?? [];
    const manualListingIds = body.manualListingIds ?? [];
    const categoryId = body.categoryId ?? null;
    const metric = body.metric ?? null;

    validateSourceFields({
      source: body.source,
      productIds,
      categoryId,
      metric,
      manualListingIds,
    });

    const section = await withRlsTransaction({ actor }, async (tx) => {
      if (categoryId) {
        const cat = await tx.category.findFirst({
          where: { id: categoryId },
          select: { id: true },
        });
        if (!cat) {
          throw new AppError(404, "Categoria não encontrada", "NOT_FOUND");
        }
      }
      if (productIds.length) {
        const found = await tx.visibilityProduct.count({
          where: { id: { in: productIds } },
        });
        if (found !== productIds.length) {
          throw new AppError(
            400,
            "Um ou mais produtos de visibilidade são inválidos",
            "HOME_SECTION_INVALID_PRODUCTS",
          );
        }
      }
      if (manualListingIds.length) {
        const found = await tx.listing.count({
          where: { id: { in: manualListingIds } },
        });
        if (found !== manualListingIds.length) {
          throw new AppError(
            400,
            "Um ou mais anúncios são inválidos",
            "HOME_SECTION_INVALID_LISTINGS",
          );
        }
      }

      const created = await tx.homeSection.create({
        data: {
          title,
          subtitle,
          source: body.source,
          layout: body.layout ?? "GRID",
          productIds: body.source === "PLACEMENT" ? productIds : [],
          categoryId: body.source === "CATEGORY" ? categoryId : null,
          metric: body.source === "METRIC" ? metric : null,
          manualListingIds: body.source === "MANUAL" ? manualListingIds : [],
          itemLimit: body.itemLimit ?? 10,
          columns: body.columns ?? 5,
          viewMoreHref:
            body.viewMoreHref === undefined || body.viewMoreHref === null
              ? null
              : sanitizeUserText(body.viewMoreHref, 300),
          viewMoreLabel:
            body.viewMoreLabel === undefined || body.viewMoreLabel === null
              ? null
              : sanitizeUserText(body.viewMoreLabel, 40),
          sortOrder: body.sortOrder ?? 0,
          active: body.active ?? true,
        },
        include: {
          category: { select: { id: true, name: true, slugPath: true } },
        },
      });
      return serializeSection(created);
    });

    res.status(201).json({ section });
    void invalidateHomeSectionsCache();
  }),
);

adminHomeSectionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = routeParam(req.params.id);
    const body = sectionUpdateSchema.parse(req.body);

    const section = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.homeSection.findFirst({ where: { id } });
      if (!existing) {
        throw new AppError(404, "Seção não encontrada", "NOT_FOUND");
      }

      const source = body.source ?? existing.source;
      const productIds =
        body.productIds !== undefined ? body.productIds : existing.productIds;
      const categoryId =
        body.categoryId !== undefined ? body.categoryId : existing.categoryId;
      const metric =
        body.metric !== undefined ? body.metric : existing.metric;
      const manualListingIds =
        body.manualListingIds !== undefined
          ? body.manualListingIds
          : existing.manualListingIds;

      validateSourceFields({
        source,
        productIds,
        categoryId,
        metric,
        manualListingIds,
      });

      if (categoryId) {
        const cat = await tx.category.findFirst({
          where: { id: categoryId },
          select: { id: true },
        });
        if (!cat) {
          throw new AppError(404, "Categoria não encontrada", "NOT_FOUND");
        }
      }
      if (productIds.length) {
        const found = await tx.visibilityProduct.count({
          where: { id: { in: productIds } },
        });
        if (found !== productIds.length) {
          throw new AppError(
            400,
            "Um ou mais produtos de visibilidade são inválidos",
            "HOME_SECTION_INVALID_PRODUCTS",
          );
        }
      }

      const updated = await tx.homeSection.update({
        where: { id },
        data: {
          title:
            body.title !== undefined
              ? sanitizeUserText(body.title, 80)
              : undefined,
          subtitle:
            body.subtitle === undefined
              ? undefined
              : body.subtitle === null
                ? null
                : sanitizeUserText(body.subtitle, 200),
          source: body.source,
          layout: body.layout,
          productIds: source === "PLACEMENT" ? productIds : [],
          categoryId: source === "CATEGORY" ? categoryId : null,
          metric: source === "METRIC" ? metric : null,
          manualListingIds: source === "MANUAL" ? manualListingIds : [],
          itemLimit: body.itemLimit,
          columns: body.columns,
          viewMoreHref:
            body.viewMoreHref === undefined
              ? undefined
              : body.viewMoreHref === null
                ? null
                : sanitizeUserText(body.viewMoreHref, 300),
          viewMoreLabel:
            body.viewMoreLabel === undefined
              ? undefined
              : body.viewMoreLabel === null
                ? null
                : sanitizeUserText(body.viewMoreLabel, 40),
          sortOrder: body.sortOrder,
          active: body.active,
        },
        include: {
          category: { select: { id: true, name: true, slugPath: true } },
        },
      });
      return serializeSection(updated);
    });

    res.json({ section });
    void invalidateHomeSectionsCache();
  }),
);

adminHomeSectionsRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = reorderSchema.parse(req.body);
    await withRlsTransaction({ actor }, async (tx) => {
      await Promise.all(
        body.orderedIds.map((sectionId, index) =>
          tx.homeSection.updateMany({
            where: { id: sectionId },
            data: { sortOrder: index },
          }),
        ),
      );
    });
    res.json({ ok: true as const });
    void invalidateHomeSectionsCache();
  }),
);

adminHomeSectionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = routeParam(req.params.id);
    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.homeSection.findFirst({ where: { id } });
      if (!existing) {
        throw new AppError(404, "Seção não encontrada", "NOT_FOUND");
      }
      await tx.homeSection.delete({ where: { id } });
    });
    res.json({ ok: true as const });
    void invalidateHomeSectionsCache();
  }),
);
