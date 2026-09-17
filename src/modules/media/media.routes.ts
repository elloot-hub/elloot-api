import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { env } from "../../config/env";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { requireAuth } from "../../middleware/auth";
import { optionalAuth } from "../../middleware/optional-auth";
import { mediaUploadLimiter } from "../../middleware/rate-limit";
import { ALLOWED_IMAGE_MIME } from "./media.image";
import {
  confirmSchema,
  presignSchema,
  uploadFieldsSchema,
} from "./media.schemas";
import {
  confirmPresignedUpload,
  createPresignSession,
  findMediaByRef,
  getMediaMeta,
  getObjectBuffer,
  issueSignedUrl,
  listMyMedia,
  resolveContentAccess,
  softDeleteMedia,
  uploadImage,
} from "./media.service";

export const mediaRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
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

mediaRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const assets = await withRlsTransaction({ actor }, (tx) =>
      listMyMedia(tx, actor),
    );
    res.json({ assets });
  }),
);

mediaRouter.post(
  "/upload",
  requireAuth,
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
      purpose: req.body?.purpose,
      visibility: req.body?.visibility,
    });

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

mediaRouter.post(
  "/presign",
  requireAuth,
  mediaUploadLimiter,
  asyncHandler(async (req, res) => {
    const body = presignSchema.parse(req.body);
    const actor = actorOf(req);
    const result = await withRlsTransaction({ actor }, (tx) =>
      createPresignSession(tx, actor, body),
    );
    res.status(201).json(result);
  }),
);

mediaRouter.post(
  "/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = confirmSchema.parse(req.body);
    const actor = actorOf(req);
    const asset = await withRlsTransaction({ actor }, (tx) =>
      confirmPresignedUpload(tx, actor, body.assetId),
    );
    res.json({ asset });
  }),
);

mediaRouter.get(
  "/:id/signed-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);
    const asset = await withRlsTransaction({ actor }, (tx) =>
      getMediaMeta(tx, actor, id),
    );
    if (asset.visibility === "PUBLIC") {
      res.json({ url: asset.url, expiresAt: null });
      return;
    }
    res.json(issueSignedUrl({ id: asset.id, code: asset.code }));
  }),
);

mediaRouter.get(
  "/:id/content",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = decodeURIComponent(routeParam(req.params.id));
    const actor = req.user
      ? { id: req.user.id, role: req.user.role }
      : null;

    const asset = await withRlsTransaction(
      { actor, asService: true },
      async (tx) => {
        const row = await findMediaByRef(tx, id, { deletedAt: null });
        if (!row) {
          throw new AppError(404, "Media not found", "MEDIA_NOT_FOUND");
        }
        await resolveContentAccess({
          asset: row,
          actor,
          query: {
            exp: typeof req.query.exp === "string" ? req.query.exp : undefined,
            nonce:
              typeof req.query.nonce === "string" ? req.query.nonce : undefined,
            sig: typeof req.query.sig === "string" ? req.query.sig : undefined,
          },
        });
        return row;
      },
    );

    const { body, mimeType } = await getObjectBuffer(asset.key);
    const type = mimeType || asset.mimeType;

    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", String(body.byteLength));
    res.setHeader(
      "Cache-Control",
      asset.visibility === "PUBLIC"
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      asset.visibility === "PRIVATE"
        ? `inline; filename="${asset.code}.bin"`
        : `inline; filename="${asset.code}.${asset.mimeType.includes("png") ? "png" : asset.mimeType.includes("webp") ? "webp" : "jpg"}"`,
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; sandbox; style-src 'none'; script-src 'none'; form-action 'none'",
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.send(body);
  }),
);

mediaRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = req.user
      ? { id: req.user.id, role: req.user.role }
      : null;
    const asset = await withRlsTransaction(
      { actor, asService: !actor },
      (tx) => getMediaMeta(tx, actor, id),
    );
    res.json({ asset });
  }),
);

mediaRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);
    const result = await withRlsTransaction({ actor }, (tx) =>
      softDeleteMedia(tx, actor, id),
    );
    res.json(result);
  }),
);
