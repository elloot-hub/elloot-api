import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";

export const adminProductTypesRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

function slugifyProductTypeCode(raw: string) {
  let code = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 32);
  if (!code) code = "TIPO";
  if (!/^[A-Z]/.test(code)) code = `T_${code}`.slice(0, 32);
  return code;
}

async function allocateUniqueCode(
  tx: {
    productType: {
      findUnique: (args: {
        where: { code: string };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  preferred: string,
) {
  const base = slugifyProductTypeCode(preferred).slice(0, 28) || "TIPO";
  for (let attempt = 0; attempt < 40; attempt++) {
    const code =
      attempt === 0 ? base : `${base.slice(0, 28)}_${attempt}`.slice(0, 32);
    if (!CODE_RE.test(code)) continue;
    const exists = await tx.productType.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!exists) return code;
  }
  throw new AppError(
    500,
    "Could not allocate product type code",
    "PRODUCT_TYPE_CODE_ALLOC",
  );
}

type LinkedCategory = {
  id: string;
  name: string;
  slugPath: string;
  enabled: boolean;
};

function serialize(
  row: {
    id: string;
    code: string;
    label: string;
    sortOrder: number;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  categories: LinkedCategory[] = [],
) {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    categories,
  };
}

const createSchema = z.object({
  /** Optional; when omitted the API derives a unique code from the label. */
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(CODE_RE))
    .optional(),
  label: z.string().trim().min(2).max(60),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  label: z.string().trim().min(2).max(60).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

adminProductTypesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const items = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.productType.findMany({
        orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
        include: {
          categories: {
            select: {
              enabled: true,
              category: {
                select: { id: true, name: true, slugPath: true },
              },
            },
            orderBy: { category: { name: "asc" } },
          },
        },
      });
      return rows.map((row) =>
        serialize(
          row,
          row.categories.map((link) => ({
            id: link.category.id,
            name: link.category.name,
            slugPath: link.category.slugPath,
            enabled: link.enabled,
          })),
        ),
      );
    });
    res.json({ items });
  }),
);

adminProductTypesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const actor = actorOf(req);
    const label = sanitizeUserText(body.label, 60);

    const item = await withRlsTransaction({ actor }, async (tx) => {
      const code = body.code
        ? await (async () => {
            const existing = await tx.productType.findUnique({
              where: { code: body.code! },
              select: { id: true },
            });
            if (existing) {
              throw new AppError(
                409,
                "Product type code already exists",
                "CONFLICT",
              );
            }
            return body.code!;
          })()
        : await allocateUniqueCode(tx, label);

      const max = await tx.productType.aggregate({ _max: { sortOrder: true } });
      const created = await tx.productType.create({
        data: {
          code,
          label,
          sortOrder: body.sortOrder ?? (max._max.sortOrder ?? -1) + 1,
          active: body.active,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "product_type.created",
          entityType: "ProductType",
          entityId: created.id,
          meta: { code: created.code, label },
        },
      });

      return serialize(created);
    });

    res.status(201).json({ item });
  }),
);

adminProductTypesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const body = updateSchema.parse(req.body);
    const actor = actorOf(req);

    const item = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.productType.findUnique({ where: { id } });
      if (!existing) {
        throw new AppError(404, "Product type not found", "NOT_FOUND");
      }

      const updated = await tx.productType.update({
        where: { id },
        data: {
          ...(body.label !== undefined
            ? { label: sanitizeUserText(body.label, 60) }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "product_type.updated",
          entityType: "ProductType",
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
  ids: z.array(z.string().min(1)).min(1).max(200),
});

adminProductTypesRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    const body = reorderSchema.parse(req.body);
    const actor = actorOf(req);

    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.productType.findMany({
        where: { id: { in: body.ids } },
        select: { id: true },
      });
      if (existing.length !== body.ids.length) {
        throw new AppError(400, "Invalid product type id", "INVALID_PRODUCT_TYPE");
      }

      await Promise.all(
        body.ids.map((id, index) =>
          tx.productType.update({
            where: { id },
            data: { sortOrder: index },
          }),
        ),
      );

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "product_type.reordered",
          entityType: "ProductType",
          entityId: null,
          meta: { ids: body.ids },
        },
      });
    });

    res.json({ ok: true });
  }),
);

adminProductTypesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.productType.findUnique({
        where: { id },
        select: { id: true, code: true },
      });
      if (!existing) {
        throw new AppError(404, "Product type not found", "NOT_FOUND");
      }

      await tx.productType.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "product_type.deleted",
          entityType: "ProductType",
          entityId: id,
          meta: { code: existing.code },
        },
      });
    });

    res.json({ ok: true });
  }),
);
