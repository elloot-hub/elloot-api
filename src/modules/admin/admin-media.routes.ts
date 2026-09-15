import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { env } from "../../config/env";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
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
