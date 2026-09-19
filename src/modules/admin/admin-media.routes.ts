import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../../config/env";
import { withRlsTransaction, withServiceTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { mediaUploadLimiter } from "../../middleware/rate-limit";
import { ALLOWED_IMAGE_MIME } from "../media/media.image";
import { uploadFieldsSchema } from "../media/media.schemas";
import { uploadImage } from "../media/media.service";

export const adminMediaRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MEDIA_MAX_BYTES,
    files: 1,
    fields: 4,
  },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(
        new AppError(
          415,
          "Only JPEG, PNG and WebP images are allowed",
          "MEDIA_UNSUPPORTED_TYPE",
        ),
      );
      return;
    }
    cb(null, true);
  },
});

function multerSingle(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(
          new AppError(
            413,
            `File too large (max ${env.MEDIA_MAX_BYTES} bytes)`,
            "MEDIA_TOO_LARGE",
          ),
        );
        return;
      }
      next(new AppError(400, err.message, "MEDIA_UPLOAD_ERROR"));
      return;
    }
    next(err);
  });
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function serializeGalleryAsset(row: {
  id: string;
  code: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  purpose: string;
  visibility: string;
  originalName: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  owner: {
    id: string;
    name: string | null;
    username: string | null;
    avatarUrl: string | null;
  } | null;
  listingsCount?: number;
  categoriesCount?: number;
}) {
  return {
    id: row.id,
    code: row.code,
    url: row.url,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sizeLabel: formatBytes(row.sizeBytes),
    width: row.width,
    height: row.height,
    purpose: row.purpose,
    visibility: row.visibility,
    originalName: row.originalName,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    owner: row.owner,
    listingsCount: row.listingsCount ?? 0,
    categoriesCount: row.categoriesCount ?? 0,
  };
}

const listSchema = z.object({
  folder: z
    .enum(["all", "listing", "category", "avatar", "general", "trash"])
    .optional()
    .default("all"),
  q: z.string().trim().max(120).optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(48),
  cursor: z.string().optional(),
});

/** Folder counts for the gallery sidebar. */
adminMediaRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [
        all,
        listing,
        category,
        avatar,
        general,
        trash,
        linkedListings,
        linkedCategories,
      ] = await Promise.all([
        tx.mediaAsset.count({ where: { deletedAt: null } }),
        tx.mediaAsset.count({ where: { deletedAt: null, purpose: "LISTING" } }),
        tx.mediaAsset.count({ where: { deletedAt: null, purpose: "CATEGORY" } }),
        tx.mediaAsset.count({ where: { deletedAt: null, purpose: "AVATAR" } }),
        tx.mediaAsset.count({ where: { deletedAt: null, purpose: "GENERAL" } }),
        tx.mediaAsset.count({ where: { deletedAt: { not: null } } }),
        tx.listingMedia.count(),
        tx.category.count({
          where: {
            OR: [{ imageUrl: { not: null } }, { iconUrl: { not: null } }],
          },
        }),
      ]);

      return {
        all,
        listing,
        category,
        avatar,
        general,
        trash,
        listingMediaRows: linkedListings,
        categoriesWithImage: linkedCategories,
      };
    });
    res.json({ stats });
  }),
);

/** Paginated gallery of tracked media assets. */
adminMediaRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listSchema.parse(req.query);
    const actor = actorOf(req);
    const q = query.q?.trim();

    const result = await withRlsTransaction({ actor }, async (tx) => {
      const purposeFilter =
        query.folder === "listing"
          ? ("LISTING" as const)
          : query.folder === "category"
            ? ("CATEGORY" as const)
            : query.folder === "avatar"
              ? ("AVATAR" as const)
              : query.folder === "general"
                ? ("GENERAL" as const)
                : undefined;

      const rows = await tx.mediaAsset.findMany({
        where: {
          ...(query.folder === "trash"
            ? { deletedAt: { not: null } }
            : { deletedAt: null }),
          ...(purposeFilter ? { purpose: purposeFilter } : {}),
          ...(q
            ? {
                OR: [
                  { code: { contains: q, mode: "insensitive" as const } },
                  {
                    originalName: {
                      contains: q,
                      mode: "insensitive" as const,
                    },
                  },
                  { url: { contains: q, mode: "insensitive" as const } },
                  {
                    owner: {
                      OR: [
                        {
                          name: { contains: q, mode: "insensitive" as const },
                        },
                        {
                          username: {
                            contains: q,
                            mode: "insensitive" as const,
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.take + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          code: true,
          url: true,
          mimeType: true,
          sizeBytes: true,
          width: true,
          height: true,
          purpose: true,
          visibility: true,
          originalName: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          owner: {
            select: {
              id: true,
              name: true,
              username: true,
              avatarUrl: true,
            },
          },
        },
      });

      const hasMore = rows.length > query.take;
      const page = hasMore ? rows.slice(0, query.take) : rows;
      const urls = page.map((r) => r.url);

      const [listingHits, categoryHits] = urls.length
        ? await Promise.all([
            tx.listingMedia.groupBy({
              by: ["url"],
              where: { url: { in: urls } },
              _count: { _all: true },
            }),
            tx.category.findMany({
              where: {
                OR: [
                  { imageUrl: { in: urls } },
                  { iconUrl: { in: urls } },
                ],
              },
              select: { imageUrl: true, iconUrl: true },
            }),
          ])
        : [[], []];

      const listingCountByUrl = new Map(
        listingHits.map((h) => [h.url, h._count._all]),
      );
      const categoryCountByUrl = new Map<string, number>();
      for (const c of categoryHits) {
        if (c.imageUrl) {
          categoryCountByUrl.set(
            c.imageUrl,
            (categoryCountByUrl.get(c.imageUrl) ?? 0) + 1,
          );
        }
        if (c.iconUrl && c.iconUrl !== c.imageUrl) {
          categoryCountByUrl.set(
            c.iconUrl,
            (categoryCountByUrl.get(c.iconUrl) ?? 0) + 1,
          );
        }
      }

      return {
        items: page.map((row) =>
          serializeGalleryAsset({
            ...row,
            listingsCount: listingCountByUrl.get(row.url) ?? 0,
            categoriesCount: categoryCountByUrl.get(row.url) ?? 0,
          }),
        ),
        nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
      };
    });

    res.json(result);
  }),
);

/** Asset detail with product and category links. */
adminMediaRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const detail = await withRlsTransaction({ actor }, async (tx) => {
      const asset = await tx.mediaAsset.findFirst({
        where: {
          OR: [{ id }, { code: id }],
        },
        select: {
          id: true,
          code: true,
          key: true,
          url: true,
          mimeType: true,
          sizeBytes: true,
          width: true,
          height: true,
          purpose: true,
          visibility: true,
          originalName: true,
          checksumSha256: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          owner: {
            select: {
              id: true,
              name: true,
              username: true,
              avatarUrl: true,
            },
          },
        },
      });
      if (!asset) return null;

      const [listingMedia, categories] = await Promise.all([
        tx.listingMedia.findMany({
          where: { url: asset.url },
          orderBy: { sortOrder: "asc" },
          take: 50,
          select: {
            id: true,
            sortOrder: true,
            listing: {
              select: {
                id: true,
                code: true,
                title: true,
                status: true,
                priceCents: true,
                seller: {
                  select: {
                    id: true,
                    name: true,
                    username: true,
                  },
                },
              },
            },
          },
        }),
        tx.category.findMany({
          where: {
            OR: [{ imageUrl: asset.url }, { iconUrl: asset.url }],
          },
          take: 50,
          select: {
            id: true,
            name: true,
            slugPath: true,
            status: true,
            imageUrl: true,
            iconUrl: true,
          },
        }),
      ]);

      return {
        asset: {
          ...serializeGalleryAsset({
            ...asset,
            listingsCount: listingMedia.length,
            categoriesCount: categories.length,
          }),
          key: asset.key,
          checksumSha256: asset.checksumSha256,
        },
        listings: listingMedia.map((m) => ({
          mediaId: m.id,
          sortOrder: m.sortOrder,
          listing: {
            id: m.listing.id,
            code: m.listing.code,
            title: m.listing.title,
            status: m.listing.status,
            priceCents: m.listing.priceCents,
            seller: m.listing.seller,
          },
        })),
        categories: categories.map((c) => ({
          id: c.id,
          name: c.name,
          slugPath: c.slugPath,
          status: c.status,
          usedAs:
            c.imageUrl === asset.url && c.iconUrl === asset.url
              ? "image_and_icon"
              : c.imageUrl === asset.url
                ? "image"
                : "icon",
        })),
      };
    });

    if (!detail) {
      throw new AppError(404, "Media not found", "NOT_FOUND");
    }
    res.json(detail);
  }),
);

/** Soft-delete (move to trash). */
adminMediaRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    await withServiceTransaction(async (tx) => {
      const existing = await tx.mediaAsset.findFirst({
        where: { OR: [{ id }, { code: id }], deletedAt: null },
        select: { id: true, code: true },
      });
      if (!existing) {
        throw new AppError(404, "Media not found", "NOT_FOUND");
      }
      await tx.mediaAsset.update({
        where: { id: existing.id },
        data: { deletedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "media.soft_deleted",
          entityType: "MediaAsset",
          entityId: existing.id,
          meta: { code: existing.code },
        },
      });
    }, actor);

    res.json({ ok: true });
  }),
);

/** Restore from trash. */
adminMediaRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);

    const asset = await withServiceTransaction(async (tx) => {
      const existing = await tx.mediaAsset.findFirst({
        where: {
          OR: [{ id }, { code: id }],
          deletedAt: { not: null },
        },
        select: { id: true, code: true },
      });
      if (!existing) {
        throw new AppError(404, "Media not found in trash", "NOT_FOUND");
      }
      const restored = await tx.mediaAsset.update({
        where: { id: existing.id },
        data: { deletedAt: null },
        select: {
          id: true,
          code: true,
          url: true,
          mimeType: true,
          sizeBytes: true,
          width: true,
          height: true,
          purpose: true,
          visibility: true,
          originalName: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          owner: {
            select: {
              id: true,
              name: true,
              username: true,
              avatarUrl: true,
            },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "media.restored",
          entityType: "MediaAsset",
          entityId: existing.id,
          meta: { code: existing.code },
        },
      });
      return serializeGalleryAsset(restored);
    }, actor);

    res.json({ asset });
  }),
);

/** Admin-only image upload (cookie elloot_admin_at). Default purpose CATEGORY. */
adminMediaRouter.post(
  "/upload",
  mediaUploadLimiter,
  multerSingle,
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer) {
      throw new AppError(
        400,
        'Missing file field "file"',
        "MEDIA_FILE_REQUIRED",
      );
    }

    const fields = uploadFieldsSchema.parse({
      purpose: req.body?.purpose ?? "CATEGORY",
      visibility: req.body?.visibility ?? "PUBLIC",
    });

    if (fields.purpose !== "CATEGORY" && fields.purpose !== "GENERAL") {
      throw new AppError(
        400,
        "Admin upload supports CATEGORY or GENERAL purpose only",
        "MEDIA_PURPOSE_FORBIDDEN",
      );
    }

    const actor = actorOf(req);
    const asset = await withRlsTransaction({ actor }, (tx) =>
      uploadImage(tx, actor, {
        buffer: req.file!.buffer,
        originalName: req.file!.originalname,
        purpose: fields.purpose,
        visibility: fields.visibility,
      }),
    );

    res.status(201).json({ asset });
  }),
);
