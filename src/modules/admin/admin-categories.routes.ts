import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";

export const adminCategoriesRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const PI_ICON_RE = /^Pi[A-Z][A-Za-z0-9]{1,62}$/;

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().min(1).max(80).optional(),
  parentId: z.string().min(1).nullable().optional(),
  icon: z.string().trim().regex(PI_ICON_RE).nullable().optional(),
  imageUrl: z
    .union([z.string().trim().url().max(500), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  showInMenu: z.boolean().optional().default(false),
  isFeatured: z.boolean().optional().default(false),
  isAdult: z.boolean().optional().default(false),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional().default("ACTIVE"),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  orderInstruction: z.string().trim().max(4000).optional(),
});

const updateSchema = createSchema.partial();

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  parentId: z.string().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

function slugify(input: string) {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "categoria";
}

function serialize(row: {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  slugPath: string;
  status: string;
  icon: string | null;
  imageUrl: string | null;
  iconUrl: string | null;
  showInMenu: boolean;
  isFeatured: boolean;
  isAdult: boolean;
  sortOrder: number;
  orderInstruction: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { children: number; listings: number };
  parent?: { id: string; name: string; slugPath: string } | null;
}) {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    slug: row.slug,
    slugPath: row.slugPath,
    status: row.status,
    icon: row.icon,
    imageUrl: row.imageUrl,
    iconUrl: row.iconUrl,
    showInMenu: row.showInMenu,
    isFeatured: row.isFeatured,
    isAdult: row.isAdult,
    sortOrder: row.sortOrder,
    orderInstruction: row.orderInstruction,
    childrenCount: row._count?.children ?? 0,
    listingsCount: row._count?.listings ?? 0,
    parent: row.parent ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listSelect = {
  id: true,
  parentId: true,
  name: true,
  slug: true,
  slugPath: true,
  status: true,
  icon: true,
  imageUrl: true,
  iconUrl: true,
  showInMenu: true,
  isFeatured: true,
  isAdult: true,
  sortOrder: true,
  orderInstruction: true,
  createdAt: true,
  updatedAt: true,
  parent: { select: { id: true, name: true, slugPath: true } },
  _count: { select: { children: true, listings: true } },
} as const;

async function uniqueSlugPath(
  tx: {
    category: {
      findUnique: (args: {
        where: { slugPath: string };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  basePath: string,
  ignoreId?: string,
) {
  let candidate = basePath;
  let n = 2;
  while (true) {
    const existing = await tx.category.findUnique({
      where: { slugPath: candidate },
      select: { id: true },
    });
    if (!existing || existing.id === ignoreId) return candidate;
    candidate = `${basePath}-${n}`;
    n += 1;
  }
}

adminCategoriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const items = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.category.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.parentId === "root"
            ? { parentId: null }
            : query.parentId
              ? { parentId: query.parentId }
              : {}),
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { slug: { contains: q, mode: "insensitive" } },
                  { slugPath: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: listSelect,
      });
      return rows.map(serialize);
    });

    res.json({ items });
  }),
);

adminCategoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const actor = actorOf(req);
    const name = sanitizeUserText(body.name, 80);
    const slug = slugify(body.slug?.trim() || name);

    const category = await withRlsTransaction({ actor }, async (tx) => {
      let parent: { id: string; slugPath: string } | null = null;
      if (body.parentId) {
        parent = await tx.category.findUnique({
          where: { id: body.parentId },
          select: { id: true, slugPath: true },
        });
        if (!parent) {
          throw new AppError(404, "Parent category not found", "NOT_FOUND");
        }
      }

      const siblingMax = await tx.category.aggregate({
        where: { parentId: parent?.id ?? null },
        _max: { sortOrder: true },
      });

      const basePath = parent
        ? `${parent.slugPath.replace(/\/$/, "")}/${slug}`
        : `/${slug}`;
      const slugPath = await uniqueSlugPath(tx, basePath);

      const created = await tx.category.create({
        data: {
          name,
          slug,
          slugPath,
          parentId: parent?.id ?? null,
          icon: body.icon ?? null,
          imageUrl: body.imageUrl ?? null,
          showInMenu: body.showInMenu,
          isFeatured: body.isFeatured,
          isAdult: body.isAdult,
          status: body.status,
          sortOrder: body.sortOrder ?? (siblingMax._max.sortOrder ?? -1) + 1,
          orderInstruction: body.orderInstruction
            ? sanitizeUserText(body.orderInstruction, 4000)
            : null,
        },
        select: listSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "category.created",
          entityType: "Category",
          entityId: created.id,
          meta: { name, slugPath, icon: body.icon ?? null },
        },
      });

      return serialize(created);
    });

    res.status(201).json({ category });
  }),
);

adminCategoriesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const category = await withRlsTransaction({ actor }, async (tx) => {
      const row = await tx.category.findUnique({
        where: { id },
        select: listSelect,
      });
      if (!row) {
        throw new AppError(404, "Category not found", "NOT_FOUND");
      }
      return serialize(row);
    });

    res.json({ category });
  }),
);

adminCategoriesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const body = updateSchema.parse(req.body);
    const actor = actorOf(req);

    const category = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.category.findUnique({
        where: { id },
        select: {
          id: true,
          parentId: true,
          slug: true,
          slugPath: true,
          name: true,
        },
      });
      if (!existing) {
        throw new AppError(404, "Category not found", "NOT_FOUND");
      }

      let parentId = existing.parentId;
      let parentPath: string | null = null;
      if (body.parentId !== undefined) {
        if (body.parentId === id) {
          throw new AppError(400, "Category cannot be its own parent", "INVALID_PARENT");
        }
        if (body.parentId) {
          const parent = await tx.category.findUnique({
            where: { id: body.parentId },
            select: { id: true, slugPath: true },
          });
          if (!parent) {
            throw new AppError(404, "Parent category not found", "NOT_FOUND");
          }
          if (parent.slugPath.startsWith(`${existing.slugPath}/`)) {
            throw new AppError(
              400,
              "Cannot move a category under its own descendant",
              "INVALID_PARENT",
            );
          }
          parentId = parent.id;
          parentPath = parent.slugPath;
        } else {
          parentId = null;
          parentPath = "";
        }
      }

      const name = body.name ? sanitizeUserText(body.name, 80) : existing.name;
      const slug = body.slug
        ? slugify(body.slug)
        : body.name
          ? slugify(name)
          : existing.slug;

      const basePath =
        parentId === existing.parentId && !body.slug && !body.name && body.parentId === undefined
          ? existing.slugPath
          : parentPath !== null
            ? parentPath
              ? `${parentPath.replace(/\/$/, "")}/${slug}`
              : `/${slug}`
            : existing.slugPath.replace(/\/[^/]+$/, `/${slug}`);

      const slugPath =
        basePath === existing.slugPath
          ? existing.slugPath
          : await uniqueSlugPath(tx, basePath, id);

      const updated = await tx.category.update({
        where: { id },
        data: {
          name,
          slug,
          slugPath,
          parentId,
          ...(body.icon !== undefined ? { icon: body.icon } : {}),
          ...(body.imageUrl !== undefined ? { imageUrl: body.imageUrl } : {}),
          ...(body.showInMenu !== undefined ? { showInMenu: body.showInMenu } : {}),
          ...(body.isFeatured !== undefined ? { isFeatured: body.isFeatured } : {}),
          ...(body.isAdult !== undefined ? { isAdult: body.isAdult } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.orderInstruction !== undefined
            ? {
                orderInstruction: body.orderInstruction
                  ? sanitizeUserText(body.orderInstruction, 4000)
                  : null,
              }
            : {}),
        },
        select: listSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "category.updated",
          entityType: "Category",
          entityId: id,
          meta: { from: existing.slugPath, to: slugPath },
        },
      });

      return serialize(updated);
    });

    res.json({ category });
  }),
);

adminCategoriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.category.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          slugPath: true,
          _count: { select: { children: true, listings: true } },
        },
      });
      if (!existing) {
        throw new AppError(404, "Category not found", "NOT_FOUND");
      }
      if (existing._count.children > 0) {
        throw new AppError(
          409,
          "Remova ou mova as subcategorias antes de excluir.",
          "CATEGORY_HAS_CHILDREN",
        );
      }
      if (existing._count.listings > 0) {
        throw new AppError(
          409,
          "Há anúncios nesta categoria. Reatribua-os ou desative a categoria.",
          "CATEGORY_HAS_LISTINGS",
        );
      }

      await tx.category.delete({ where: { id } });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "category.deleted",
          entityType: "Category",
          entityId: id,
          meta: { name: existing.name, slugPath: existing.slugPath },
        },
      });
    });

    res.json({ ok: true });
  }),
);
