import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, withServiceTransaction } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, invalidateAuthUserCache } from "../../middleware/auth";
import { kycSubmitLimiter } from "../../middleware/rate-limit";
import { getMyKyc, submitKyc } from "./kyc.service";

export const kycRouter = Router();

const submitSchema = z.object({
  fullName: z.string().trim().min(3).max(80),
  documentNumber: z.string().trim().min(11).max(18),
  frontAssetId: z.string().min(1),
  backAssetId: z.string().min(1),
  selfieAssetId: z.string().min(1),
});

kycRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = { id: req.user!.id, role: req.user!.role };
    const kyc = await withRlsTransaction({ actor }, (tx) =>
      getMyKyc(tx, actor.id),
    );
    res.json(kyc);
  }),
);

kycRouter.post(
  "/",
  requireAuth,
  kycSubmitLimiter,
  asyncHandler(async (req, res) => {
    const body = submitSchema.parse(req.body);
    const userId = req.user!.id;

    const submission = await withServiceTransaction((tx) =>
      submitKyc(tx, {
        userId,
        fullName: body.fullName,
        documentNumber: body.documentNumber,
        frontAssetId: body.frontAssetId,
        backAssetId: body.backAssetId,
        selfieAssetId: body.selfieAssetId,
      }),
    );

    invalidateAuthUserCache(userId);
    res.status(201).json({ submission, kycStatus: "PENDING" });
  }),
);
