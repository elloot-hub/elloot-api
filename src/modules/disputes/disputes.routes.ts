import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { routeParam } from "../../lib/route-param";
import { requireAuth, requireRole } from "../../middleware/auth";
import type { RlsActor } from "../../databases";
import { openDispute, resolveDispute } from "./disputes.service";
import { withRlsTransaction } from "../../databases";
import { AppError } from "../../lib/errors";
import { disputeWhereByRef } from "../../lib/entity-ref";

export const disputesRouter = Router();

const openSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().min(10).max(2000),
});

const resolveSchema = z.object({
  resolution: z.enum(["RELEASE_TO_SELLER", "REFUND_BUYER", "PARTIAL"]),
  notes: z.string().trim().max(2000).optional(),
  sellerAmountCents: z.number().int().positive().optional(),
});

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

const disputeSelect = {
  id: true,
  code: true,
  orderId: true,
  openedById: true,
  reason: true,
  status: true,
  resolution: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      amountCents: true,
      feeCents: true,
      buyerId: true,
      sellerId: true,
      listing: { select: { id: true, code: true, title: true } },
    },
  },
} as const;

disputesRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = openSchema.parse(req.body);
    const actor = actorOf(req);
    const dispute = await openDispute({
      orderId: body.orderId,
      reason: body.reason,
      actor,
    });
    res.status(201).json({ dispute });
  }),
);

disputesRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const disputes = await withRlsTransaction({ actor }, (tx) =>
      tx.dispute.findMany({
        where: {
          OR: [
            { openedById: actor.id },
            { order: { buyerId: actor.id } },
            { order: { sellerId: actor.id } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: disputeSelect,
      }),
    );
    res.json({ disputes });
  }),
);

disputesRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const dispute = await withRlsTransaction({ actor }, (tx) =>
      tx.dispute.findUnique({ where: disputeWhereByRef(ref), select: disputeSelect }),
    );
    if (!dispute) {
      throw new AppError(404, "Dispute not found", "DISPUTE_NOT_FOUND");
    }
    res.json({ dispute });
  }),
);

disputesRouter.post(
  "/:id/resolve",
  requireAuth,
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const body = resolveSchema.parse(req.body);
    const actor = actorOf(req);
    const dispute = await resolveDispute({
      disputeId: routeParam(req.params.id),
      resolution: body.resolution,
      notes: body.notes,
      sellerAmountCents: body.sellerAmountCents,
      actor,
    });
    res.json({ dispute });
  }),
);
