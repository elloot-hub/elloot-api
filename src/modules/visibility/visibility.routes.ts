import { Router } from "express";
import { z } from "zod";
import {
  withRlsTransaction,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { requireAuth } from "../../middleware/auth";
import { listingWhereByRef } from "../listings/listing-ref";
import { invalidateHomeSectionsCache } from "../home/home.cache";
import {
  listActiveVisibilityProducts,
  listListingPlacements,
  purchaseVisibilityWithWallet,
} from "./visibility.service";

export const visibilityRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

const purchaseSchema = z.object({
  productId: z.string().min(1),
  method: z.enum(["wallet"]).optional().default("wallet"),
});

/** Public catalog of active visibility products. */
visibilityRouter.get(
  "/products",
  asyncHandler(async (_req, res) => {
    const products = await withRlsTransaction({ actor: null }, (tx) =>
      listActiveVisibilityProducts(tx),
    );
    res.json({ products });
  }),
);

visibilityRouter.get(
  "/listings/:id/placements",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const placements = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await tx.listing.findFirst({
        where: {
          ...listingWhereByRef(ref),
          sellerId: actor.id,
        },
        select: { id: true },
      });
      if (!listing) {
        throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
      }
      return listListingPlacements(tx, listing.id);
    });
    res.json({ placements });
  }),
);

/**
 * Purchase / renew a visibility placement for a listing.
 * Wallet debit: activates immediately or enqueues when slots are full.
 */
visibilityRouter.post(
  "/listings/:id/purchase",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const body = purchaseSchema.parse(req.body);

    if (body.method !== "wallet") {
      throw new AppError(
        400,
        "Método de pagamento não suportado",
        "UNSUPPORTED_PAYMENT_METHOD",
      );
    }

    const result = await withServiceTransaction(async (tx) =>
      purchaseVisibilityWithWallet(tx, {
        actorId: actor.id,
        listingRef: ref,
        productId: body.productId,
      }),
    );

    res.status(201).json(result);
    void invalidateHomeSectionsCache();
  }),
);
