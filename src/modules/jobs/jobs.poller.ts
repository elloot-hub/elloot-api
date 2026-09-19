import { env } from "../../config/env";
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

let timer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

async function tick() {
  try {
    const expired = await expirePendingOrders();
    const released = await autoReleaseDueEscrows();
    const placementResult = await withServiceTransaction(async (tx) => {
      const expiredPlacements = await expireVisibilityPlacements(tx);
      const promoted = await promoteQueuedPlacements(tx);
      const boosts = await reconcileVisibilityBoosts(tx);
      return { ...expiredPlacements, ...promoted, ...boosts };
    });
    if (
      placementResult.expiredPlacements > 0 ||
      placementResult.promoted > 0
    ) {
      void invalidateHomeSectionsCache();
    }
    if (
      expired.expired > 0 ||
      released.released > 0 ||
      placementResult.expiredPlacements > 0 ||
      placementResult.promoted > 0
    ) {
      console.log(
        `[jobs] expired=${expired.expired} autoReleased=${released.released} placements=${placementResult.expiredPlacements} promoted=${placementResult.promoted}`,
      );
    }

    tickCount += 1;
    if (
      env.MEDIA_GC_ENABLED &&
      tickCount % env.MEDIA_GC_EVERY_TICKS === 0
    ) {
      const gc = await runMediaGc({
        dryRun: false,
        softDelete: true,
        purge: Boolean(env.MEDIA_GC_PURGE_ENABLED),
      });
      if (
        gc.softDeleted > 0 ||
        gc.incompleteSoftDeleted > 0 ||
        gc.purged > 0 ||
        gc.orphanCandidates > 0
      ) {
        console.log(
          `[jobs] media-gc orphans=${gc.orphanCandidates} softDeleted=${gc.softDeleted} incomplete=${gc.incompleteSoftDeleted} purged=${gc.purged}`,
        );
      }
    }
  } catch (error) {
    console.error("[jobs] poll failed:", error);
  }
}

export function startJobPoller() {
  if (env.JOB_POLL_MS <= 0) {
    console.log("[jobs] poller disabled (JOB_POLL_MS=0)");
    return;
  }
  if (timer) return;

  void tick();
  timer = setInterval(() => void tick(), env.JOB_POLL_MS);
  timer.unref?.();
  console.log(`[jobs] poller every ${env.JOB_POLL_MS}ms`);
  if (env.MEDIA_GC_ENABLED) {
    console.log(
      `[jobs] media-gc enabled every ${env.MEDIA_GC_EVERY_TICKS} ticks (purge=${Boolean(env.MEDIA_GC_PURGE_ENABLED)})`,
    );
  }
}

export function stopJobPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
