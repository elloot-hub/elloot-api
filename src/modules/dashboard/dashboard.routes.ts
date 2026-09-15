import { Router } from "express";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { loadDashboardSummary } from "./dashboard.service";

export const dashboardRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

dashboardRouter.get(
  "/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const summary = await withRlsTransaction({ actor }, (tx) =>
      loadDashboardSummary(tx, actor),
    );
    res.json({ summary });
  }),
);
