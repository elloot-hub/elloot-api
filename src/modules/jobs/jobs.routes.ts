import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireJobAuth } from "../../middleware/job-auth";
import {
  autoReleaseDueEscrows,
  expirePendingOrders,
} from "../orders/orders.lifecycle";
import { runMediaGc } from "../media/media.gc";
import { withServiceTransaction } from "../../databases";
import {
  expireVisibilityPlacements,
  promoteQueuedPlacements,
  reconcileVisibilityBoosts,
} from "../visibility/visibility.service";
import { invalidateHomeSectionsCache } from "../home/home.cache";

export const jobsRouter = Router();

jobsRouter.post(
  "/expire-checkouts",
  requireJobAuth,
  asyncHandler(async (_req, res) => {
    const result = await expirePendingOrders();
    res.json({ ok: true, ...result });
  }),
);

jobsRouter.post(
  "/auto-release-escrow",
  requireJobAuth,
  asyncHandler(async (_req, res) => {
    const result = await autoReleaseDueEscrows();
    res.json({ ok: true, ...result });
  }),
);

jobsRouter.post(
  "/expire-placements",
  requireJobAuth,
  asyncHandler(async (_req, res) => {
    const result = await withServiceTransaction(async (tx) => {
      const expired = await expireVisibilityPlacements(tx);
      const promoted = await promoteQueuedPlacements(tx);
      const boosts = await reconcileVisibilityBoosts(tx);
      return { ...expired, ...promoted, ...boosts };
    });
    if (result.expiredPlacements > 0 || result.promoted > 0) {
      void invalidateHomeSectionsCache();
    }
    res.json({ ok: true, ...result });
  }),
);

jobsRouter.post(
  "/media-gc",
  requireJobAuth,
  asyncHandler(async (req, res) => {
    const dryRun = req.query.dryRun !== "0" && req.query.dryRun !== "false";
    const purge = req.query.purge === "1" || req.query.purge === "true";
    const result = await runMediaGc({
      dryRun,
      softDelete: true,
      purge: purge && !dryRun,
    });
    res.json({ ok: true, ...result });
  }),
);

jobsRouter.post(
  "/run",
  requireJobAuth,
  asyncHandler(async (_req, res) => {
    const expired = await expirePendingOrders();
    const released = await autoReleaseDueEscrows();
    const placements = await withServiceTransaction(async (tx) => {
      const expiredPlacements = await expireVisibilityPlacements(tx);
      const promoted = await promoteQueuedPlacements(tx);
      const boosts = await reconcileVisibilityBoosts(tx);
      return { ...expiredPlacements, ...promoted, ...boosts };
    });
    if (placements.expiredPlacements > 0 || placements.promoted > 0) {
      void invalidateHomeSectionsCache();
    }
    res.json({ ok: true, ...expired, ...released, ...placements });
  }),
);
