import { Router } from "express";
import { Prisma } from "@prisma/client";
import { withRlsTransaction } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import {
  getHomeSectionsCache,
  homeSectionsCacheTtlSec,
  setHomeSectionsCache,
} from "./home.cache";
import { resolveHomeSections } from "./home.service";

export const homeRouter = Router();

function isMissingTableError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2021"
  );
}

type HomeSectionsPayload = {
  sections: Awaited<ReturnType<typeof resolveHomeSections>>;
};

/**
 * Public homepage sections with resolved listings.
 * Short-lived cache (Redis + memory) + Cache-Control for CDN/edge.
 */
homeRouter.get(
  "/sections",
  asyncHandler(async (_req, res) => {
    const ttl = homeSectionsCacheTtlSec();
    if (ttl > 0) {
      res.setHeader(
        "Cache-Control",
        `public, max-age=${Math.min(30, ttl)}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
      );
    } else {
      res.setHeader("Cache-Control", "no-store");
    }

    try {
      if (ttl > 0) {
        const cached = await getHomeSectionsCache<HomeSectionsPayload>();
        if (cached) {
          res.setHeader("X-Home-Cache", "HIT");
          res.json(cached);
          return;
        }
      }

      const sections = await withRlsTransaction(
        { actor: null, asService: true, timeout: 60_000 },
        async (tx) => resolveHomeSections(tx),
      );
      const payload: HomeSectionsPayload = { sections };
      if (ttl > 0) {
        await setHomeSectionsCache(payload);
      }
      res.setHeader("X-Home-Cache", "MISS");
      res.json(payload);
    } catch (err) {
      if (isMissingTableError(err)) {
        res.json({ sections: [] });
        return;
      }
      throw err;
    }
  }),
);
