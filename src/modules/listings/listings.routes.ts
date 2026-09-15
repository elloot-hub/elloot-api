import { Router } from "express";
import {
  withRlsTransaction,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { setAuthCookie } from "../../lib/auth-cookie";
import { optionalAuth } from "../../middleware/optional-auth";
import {
  invalidateAuthUserCache,
  requireAuth,
  signAccessToken,
  verifyAccessToken,
} from "../../middleware/auth";
import { revokeAccessToken } from "../auth/token-revoke";
import { createListingSchema, reorderOffersSchema, updateListingSchema, updateListingStockSchema } from "./listings.schemas";
import { createWithPublicCode } from "../../lib/create-with-code";
import {
  assertLeafCategory,
  resolveOwnedListingMedia,
} from "./listings.media";
import {
  applyImmediateOffersOnlyTx,
  applyListingUpdateTx,
  getPendingModerationForListingTx,
  splitListingUpdate,
  submitListingForReviewTx,
  upsertPendingRevisionTx,
} from "./listings.moderation";
import {
  listingPublicSelect,
  serializeListingPublic,
  aggregateSellerReviews,
  emptySellerReviewAgg,
} from "./listings.shared";
import {
  listingEventBodySchema,
  recordListingEvent,
} from "./listings.events";
import {
  loadOwnerAutoStockLines,
  loadOwnerAutoStockItems,
  normalizeAutoStockLines,
  appendAutoStockLines,
  removeAutoStockItems,
  reconcileAutoStockQuantity,
  syncListingAutoStock,
  syncOfferAutoStock,
} from "./delivery-stock.service";
import { listingWhereByRef } from "./listing-ref";

export const listingsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

function hasPayloadKeys(obj: Record<string, unknown>) {
  return Object.keys(obj).length > 0;
}

function attachModerationMeta<T extends Record<string, unknown>>(
  listing: T,
  extra: {
    moderationNote?: string | null;
    submittedForReviewAt?: Date | null;
    pendingModeration?: Awaited<
      ReturnType<typeof getPendingModerationForListingTx>
    >;
  },
) {
  return {
    ...listing,
    moderationNote: extra.moderationNote ?? null,
    submittedForReviewAt:
      extra.submittedForReviewAt?.toISOString() ?? null,
    pendingModeration: extra.pendingModeration
      ? {
          id: extra.pendingModeration.id,
          type: extra.pendingModeration.type,
          status: extra.pendingModeration.status,
          changedFields: extra.pendingModeration.changedFields,
          reviewNote: extra.pendingModeration.reviewNote,
          createdAt: extra.pendingModeration.createdAt.toISOString(),
          updatedAt: extra.pendingModeration.updatedAt.toISOString(),
        }
      : null,
  } as T & {
    moderationNote: string | null;
    submittedForReviewAt: string | null;
    pendingModeration: {
      id: string;
      type: string;
      status: string;
      changedFields: string[];
      reviewNote: string | null;
      createdAt: string;
      updatedAt: string;
    } | null;
  };
}

listingsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const listings = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.listing.findMany({
        where: { sellerId: actor.id, status: { not: "REMOVED" } },
        orderBy: { updatedAt: "desc" },
        select: {
          ...listingPublicSelect,
          moderationNote: true,
          submittedForReviewAt: true,
        },
      });

      return Promise.all(
        rows.map(async (row) => {
          const pending = await getPendingModerationForListingTx(tx, row.id);
          const { moderationNote, submittedForReviewAt, ...listing } = row;
          const payload = attachModerationMeta(listing, {
            moderationNote,
            submittedForReviewAt,
            pendingModeration: pending,
          }) as Record<string, unknown>;

          if (listing.listingModel === "DYNAMIC") {
            payload.offers = await Promise.all(
              listing.offers.map(async (offer) => ({
                ...offer,
                autoStockItems:
                  offer.deliveryMode === "AUTO"
                    ? await loadOwnerAutoStockItems(tx, { offerId: offer.id })
                    : [],
                autoStockLines:
                  offer.deliveryMode === "AUTO"
                    ? await loadOwnerAutoStockLines(tx, { offerId: offer.id })
                    : [],
              })),
            );
          } else if (listing.deliveryMode === "AUTO") {
            const items = await loadOwnerAutoStockItems(tx, {
              listingId: listing.id,
            });
            payload.autoStockItems = items;
            payload.autoStockLines = items.map((i) => i.content);
          }

          return payload;
        }),
      );
    });
    res.json({ listings });
  }),
);

listingsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createListingSchema.parse(req.body);
    const title = sanitizeUserText(body.title, 120);
    const description = sanitizeUserText(body.description, 5000);
    const actor = actorOf(req);

    let promotedToSeller = false;
    const result = await withRlsTransaction({ actor }, async (tx) => {
      await assertLeafCategory(tx, body.categoryId);

      if (actor.role === "BUYER") {
        await tx.user.update({
          where: { id: actor.id },
          data: { role: "SELLER" },
        });
        actor.role = "SELLER";
        req.user!.role = "SELLER";
        promotedToSeller = true;
      }

      const listingModel = body.listingModel ?? "NORMAL";
      const offers = body.offers ?? [];
      const priceCents =
        listingModel === "DYNAMIC"
          ? Math.min(...offers.map((o) => o.priceCents))
          : body.priceCents!;

      const mediaRows = await resolveOwnedListingMedia(tx, actor.id, {
        mediaAssetIds: body.mediaAssetIds,
        mediaUrls: body.mediaUrls,
      });

      const listing = await createWithPublicCode({
        kind: "LST",
        create: (code) =>
          tx.listing.create({
            data: {
              code,
              sellerId: actor.id,
              categoryId: body.categoryId,
              title,
              description,
              priceCents,
              stockQuantity: body.stockQuantity ?? 1,
              productType: body.productType ?? null,
              listingModel,
              deliveryMode:
                listingModel === "DYNAMIC"
                  ? offers.some((o) => o.deliveryMode === "AUTO")
                    ? "AUTO"
                    : "MANUAL"
                  : (body.deliveryMode ?? "MANUAL"),
              status: body.publish ? "PENDING_REVIEW" : "DRAFT",
              submittedForReviewAt: body.publish ? new Date() : null,
              media: mediaRows.length
                ? {
                    create: mediaRows.map((row) => ({
                      url: row.url,
                      sortOrder: row.sortOrder,
                    })),
                  }
                : undefined,
              offers:
                listingModel === "DYNAMIC"
                  ? {
                      create: offers.map((offer, index) => ({
                        title: sanitizeUserText(offer.title, 120),
                        priceCents: offer.priceCents,
                        stockQuantity: offer.stockQuantity ?? 1,
                        deliveryMode: offer.deliveryMode ?? "MANUAL",
                        sortOrder: index,
                      })),
                    }
                  : undefined,
            },
            select: listingPublicSelect,
          }),
      });

      if (body.publish) {
        await tx.listingModerationQueue.create({
          data: {
            listingId: listing.id,
            type: "INITIAL",
            status: "PENDING",
            payload: {},
            changedFields: ["initial"],
          },
        });
      }

      if (listingModel === "DYNAMIC") {
        const createdOffers = await tx.listingOffer.findMany({
          where: { listingId: listing.id },
          orderBy: { sortOrder: "asc" },
          select: { id: true },
        });
        for (let i = 0; i < offers.length; i++) {
          const input = offers[i]!;
          if ((input.deliveryMode ?? "MANUAL") === "AUTO") {
            const lines = normalizeAutoStockLines(input.autoStockLines);
            if (!lines.length) {
              throw new AppError(
                400,
                "Auto stock lines required for offer",
                "VALIDATION_ERROR",
              );
            }
            const offerId = createdOffers[i]?.id;
            if (!offerId) continue;
            await syncOfferAutoStock(tx, offerId, lines);
          }
        }
      } else if ((body.deliveryMode ?? "MANUAL") === "AUTO") {
        const lines = normalizeAutoStockLines(body.autoStockLines);
        if (!lines.length) {
          throw new AppError(
            400,
            "Auto stock lines required",
            "VALIDATION_ERROR",
          );
        }
        await syncListingAutoStock(tx, listing.id, lines);
      }

      return tx.listing.findUniqueOrThrow({
        where: { id: listing.id },
        select: listingPublicSelect,
      });
    });

    if (promotedToSeller) {
      const accessToken = signAccessToken({
        id: req.user!.id,
        email: req.user!.email,
        role: "SELLER",
        name: req.user!.name,
        avatarUrl: req.user!.avatarUrl,
        kycStatus: req.user!.kycStatus,
      });
      if (req.accessToken) {
        try {
          const prev = verifyAccessToken(req.accessToken);
          await revokeAccessToken(req.accessToken, {
            jti: prev.jti,
            expiresAtMs: prev.exp ? prev.exp * 1000 : undefined,
          });
        } catch {
          /* ignore */
        }
      }
      invalidateAuthUserCache(req.user!.id);
      setAuthCookie(res, accessToken);
    }

    res.status(201).json({
      listing: result,
      moderation: body.publish
        ? {
            status: "PENDING_REVIEW",
            message:
              "Anúncio enviado para análise. Você será notificado quando for aprovado.",
          }
        : null,
    });
  }),
);

listingsRouter.post(
  "/:id/events",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const ref = routeParam(req.params.id);
    const body = listingEventBodySchema.parse(req.body);
    const result = await recordListingEvent({
      listingId: ref,
      type: body.type,
      visitorKey: body.visitorKey,
      viewerUserId: req.user?.id ?? null,
      amountCents: body.amountCents,
    });
    res.status(202).json(result);
  }),
);

listingsRouter.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const ref = routeParam(req.params.id);
    const actor = req.user
      ? { id: req.user.id, role: req.user.role }
      : null;

    const row = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await tx.listing.findUnique({
        where: listingWhereByRef(ref),
        select: {
          ...listingPublicSelect,
          moderationNote: true,
          submittedForReviewAt: true,
        },
      });
      if (!listing) return null;

      const isOwner =
        req.user?.id === listing.seller.id || req.user?.role === "ADMIN";
      if (listing.status !== "ACTIVE" && !isOwner) {
        return null;
      }

      let pendingModeration = null;
      if (isOwner) {
        pendingModeration = await getPendingModerationForListingTx(
          tx,
          listing.id,
        );
      }

      return { listing, isOwner, pendingModeration };
    });

    if (!row || row.listing.status === "REMOVED") {
      throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
    }

    // Align displayed stock with real auto-delivery keys (legacy listings
    // may have stockQuantity without delivery_stock_items rows).
    if (row.listing.deliveryMode === "AUTO" || row.listing.offers.some((o) => o.deliveryMode === "AUTO")) {
      await withServiceTransaction(async (tx) => {
        if (row.listing.listingModel === "DYNAMIC") {
          for (const offer of row.listing.offers) {
            if (offer.deliveryMode === "AUTO") {
              const available = await reconcileAutoStockQuantity(tx, {
                listingId: row.listing.id,
                offerId: offer.id,
              });
              offer.stockQuantity = available;
            }
          }
        } else if (row.listing.deliveryMode === "AUTO") {
          row.listing.stockQuantity = await reconcileAutoStockQuantity(tx, {
            listingId: row.listing.id,
          });
        }
      });
    }

    const reviewRows = await withRlsTransaction({ actor }, (tx) =>
      tx.review.findMany({
        where: { sellerId: row.listing.seller.id },
        select: { rating: true },
        take: 5000,
      }),
    ).catch(() => [] as Array<{ rating: number }>);

    const reviewAgg =
      reviewRows.length > 0
        ? aggregateSellerReviews(reviewRows)
        : emptySellerReviewAgg();

    const { moderationNote, submittedForReviewAt, ...publicListing } =
      row.listing;

    let listingPayload = serializeListingPublic(publicListing, reviewAgg) as Record<
      string,
      unknown
    >;
    if (row.isOwner) {
      const ownerStock = await withRlsTransaction({ actor }, async (tx) => {
        if (row.listing.listingModel === "DYNAMIC") {
          const offerLines: Record<string, string[]> = {};
          const offerItems: Record<string, Array<{ id: string; content: string }>> =
            {};
          for (const offer of row.listing.offers) {
            const items = await loadOwnerAutoStockItems(tx, {
              offerId: offer.id,
            });
            offerItems[offer.id] = items;
            offerLines[offer.id] = items.map((i) => i.content);
          }
          return { offerLines, offerItems };
        }
        const items = await loadOwnerAutoStockItems(tx, {
          listingId: row.listing.id,
        });
        return {
          lines: items.map((i) => i.content),
          items,
        };
      });

      if (row.listing.listingModel === "DYNAMIC" && ownerStock.offerLines) {
        listingPayload.offers = (
          listingPayload.offers as Array<Record<string, unknown>>
        ).map((offer) => ({
          ...offer,
          autoStockLines:
            ownerStock.offerLines[(offer.id as string) ?? ""] ?? [],
          autoStockItems:
            ownerStock.offerItems?.[(offer.id as string) ?? ""] ?? [],
        }));
      } else if (ownerStock.lines) {
        listingPayload.autoStockLines = ownerStock.lines;
        listingPayload.autoStockItems = ownerStock.items ?? [];
      }

      listingPayload = attachModerationMeta(listingPayload, {
        moderationNote,
        submittedForReviewAt,
        pendingModeration: row.pendingModeration,
      });
    }

    res.json({ listing: listingPayload });
  }),
);

listingsRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateListingSchema.parse(req.body);
    const actor = actorOf(req);
    const id = routeParam(req.params.id);

    const outcome = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await getOwnedListingTx(tx, id, actor);
      if (listing.status === "SOLD") {
        throw new AppError(409, "Listing already sold", "LISTING_SOLD");
      }

      if (!["ACTIVE", "PAUSED"].includes(listing.status)) {
        const updated = await applyListingUpdateTx(tx, {
          ownerId: actor.id,
          listing,
          body,
        });
        const meta = await tx.listing.findUnique({
          where: { id: listing.id },
          select: { moderationNote: true, submittedForReviewAt: true },
        });
        const pending = await getPendingModerationForListingTx(tx, listing.id);
        return {
          listing: attachModerationMeta(updated, {
            moderationNote: meta?.moderationNote,
            submittedForReviewAt: meta?.submittedForReviewAt,
            pendingModeration: pending,
          }),
          moderation: {
            appliedImmediately: Object.keys(body),
            pendingRevision: null,
          },
        };
      }

      const existingOffers = await tx.listingOffer.findMany({
        where: { listingId: listing.id },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          title: true,
          priceCents: true,
          stockQuantity: true,
          deliveryMode: true,
          sortOrder: true,
        },
      });

      const existingMedia = await tx.listingMedia.findMany({
        where: { listingId: listing.id },
        orderBy: { sortOrder: "asc" },
        select: { url: true },
      });

      const split = splitListingUpdate(
        body,
        listing.status,
        existingOffers,
        existingMedia.map((m) => m.url),
      );

      let updated = await tx.listing.findUnique({
        where: { id: listing.id },
        select: listingPublicSelect,
      });

      const appliedImmediately: string[] = [];

      if (hasPayloadKeys(split.immediate as Record<string, unknown>)) {
        if (split.immediate.offers?.length) {
          updated =
            (await applyImmediateOffersOnlyTx(
              tx,
              listing.id,
              listing.listingModel,
              split.immediate.offers,
            )) ?? updated;
          appliedImmediately.push(...split.changedFields.filter((f) =>
            f.startsWith("offers."),
          ));
        }

        const scalarImmediate = { ...split.immediate };
        delete scalarImmediate.offers;
        delete scalarImmediate.mediaAssetIds;
        delete scalarImmediate.mediaUrls;

        if (
          scalarImmediate.priceCents !== undefined ||
          scalarImmediate.stockQuantity !== undefined
        ) {
          updated = await tx.listing.update({
            where: { id: listing.id },
            data: {
              priceCents: scalarImmediate.priceCents,
              stockQuantity: scalarImmediate.stockQuantity,
            },
            select: listingPublicSelect,
          });
          if (scalarImmediate.priceCents !== undefined) {
            appliedImmediately.push("priceCents");
          }
          if (scalarImmediate.stockQuantity !== undefined) {
            appliedImmediately.push("stockQuantity");
          }
        }

        if (split.immediate.mediaAssetIds || split.immediate.mediaUrls) {
          await applyListingUpdateTx(tx, {
            ownerId: actor.id,
            listing,
            body: {
              mediaAssetIds: split.immediate.mediaAssetIds,
              mediaUrls: split.immediate.mediaUrls,
            },
          });
          updated = await tx.listing.findUnique({
            where: { id: listing.id },
            select: listingPublicSelect,
          });
          appliedImmediately.push("media");
        }
      }

      let pendingRevision = null;

      if (hasPayloadKeys(split.moderated as Record<string, unknown>)) {
        const moderatedFields = split.changedFields.filter(
          (f) =>
            !appliedImmediately.includes(f) &&
            f !== "priceCents" &&
            f !== "stockQuantity" &&
            !f.startsWith("offers.priceCents") &&
            !f.startsWith("offers.stockQuantity") &&
            f !== "offers.removed",
        );

        pendingRevision = await upsertPendingRevisionTx(
          tx,
          listing.id,
          split.moderated,
          moderatedFields.length ? moderatedFields : split.changedFields,
        );
      }

      const pending = await getPendingModerationForListingTx(tx, listing.id);
      const meta = await tx.listing.findUnique({
        where: { id: listing.id },
        select: { moderationNote: true, submittedForReviewAt: true },
      });

      return {
        listing: attachModerationMeta(updated!, {
          moderationNote: meta?.moderationNote,
          submittedForReviewAt: meta?.submittedForReviewAt,
          pendingModeration: pending,
        }),
        moderation: {
          appliedImmediately: [...new Set(appliedImmediately)],
          pendingRevision: pendingRevision
            ? {
                id: pendingRevision.id,
                changedFields: pendingRevision.changedFields,
                message:
                  "Alterações enviadas para análise. O anúncio continua no ar com a versão atual até aprovação.",
              }
            : null,
        },
      };
    });

    res.json(outcome);
  }),
);

listingsRouter.post(
  "/:id/publish",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const result = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await getOwnedListingTx(
        tx,
        routeParam(req.params.id),
        actor,
      );
      const updated = await submitListingForReviewTx(tx, listing.id);
      const pending = await getPendingModerationForListingTx(tx, listing.id);
      const meta = await tx.listing.findUnique({
        where: { id: listing.id },
        select: { submittedForReviewAt: true },
      });
      return attachModerationMeta(updated, {
        moderationNote: null,
        submittedForReviewAt: meta?.submittedForReviewAt ?? new Date(),
        pendingModeration: pending,
      });
    });

    res.json({
      listing: result,
      moderation: {
        status: "PENDING_REVIEW",
        message:
          "Anúncio enviado para análise. Você será notificado quando for aprovado.",
      },
    });
  }),
);

listingsRouter.patch(
  "/:id/offers/reorder",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = reorderOffersSchema.parse(req.body);
    const actor = actorOf(req);
    const listingId = routeParam(req.params.id);

    const listing = await withRlsTransaction({ actor }, async (tx) => {
      const owned = await getOwnedListingTx(tx, listingId, actor);
      if (owned.listingModel !== "DYNAMIC") {
        throw new AppError(
          400,
          "Only dynamic listings have offers to reorder",
          "INVALID_LISTING_MODEL",
        );
      }

      const existing = await tx.listingOffer.findMany({
        where: { listingId: owned.id },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((o) => o.id));

      if (body.offerIds.length !== existing.length) {
        throw new AppError(
          400,
          "offerIds must include every offer exactly once",
          "INVALID_OFFER_ORDER",
        );
      }

      const seen = new Set<string>();
      for (const id of body.offerIds) {
        if (!existingIds.has(id) || seen.has(id)) {
          throw new AppError(400, "Invalid offer id", "OFFER_NOT_FOUND");
        }
        seen.add(id);
      }

      for (const [index, offerId] of body.offerIds.entries()) {
        await tx.listingOffer.update({
          where: { id: offerId },
          data: { sortOrder: index },
        });
      }

      return tx.listing.findUnique({
        where: { id: owned.id },
        select: listingPublicSelect,
      });
    });

    res.json({ listing });
  }),
);

listingsRouter.patch(
  "/:id/stock",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateListingStockSchema.parse(req.body);
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);

    const listing = await withRlsTransaction({ actor }, async (tx) => {
      const owned = await getOwnedListingTx(tx, ref, actor);
      if (owned.status === "REMOVED" || owned.status === "SOLD") {
        // Allow restocking SOLD auto/manual listings so they can reopen.
        if (owned.status === "REMOVED") {
          throw new AppError(409, "Listing removed", "LISTING_REMOVED");
        }
      }

      if (owned.listingModel === "DYNAMIC") {
        if (!body.offerId) {
          throw new AppError(400, "offerId is required", "OFFER_REQUIRED");
        }
        const offer = await tx.listingOffer.findFirst({
          where: { id: body.offerId, listingId: owned.id },
          select: { id: true, deliveryMode: true },
        });
        if (!offer) {
          throw new AppError(404, "Offer not found", "OFFER_NOT_FOUND");
        }

        if (offer.deliveryMode === "AUTO") {
          if (body.replaceLines !== undefined) {
            await syncOfferAutoStock(tx, offer.id, body.replaceLines);
          }
          if (body.removeItemIds?.length) {
            await removeAutoStockItems(
              tx,
              { listingId: owned.id, offerId: offer.id },
              body.removeItemIds,
            );
          }
          if (body.appendLines?.length) {
            await appendAutoStockLines(
              tx,
              { listingId: owned.id, offerId: offer.id },
              body.appendLines,
            );
          }
        } else {
          if (body.stockQuantity === undefined) {
            throw new AppError(
              400,
              "stockQuantity is required for manual delivery",
              "VALIDATION_ERROR",
            );
          }
          await tx.listingOffer.update({
            where: { id: offer.id },
            data: { stockQuantity: body.stockQuantity },
          });
        }
      } else if (owned.deliveryMode === "AUTO") {
        if (body.replaceLines !== undefined) {
          await syncListingAutoStock(tx, owned.id, body.replaceLines);
        }
        if (body.removeItemIds?.length) {
          await removeAutoStockItems(
            tx,
            { listingId: owned.id },
            body.removeItemIds,
          );
        }
        if (body.appendLines?.length) {
          await appendAutoStockLines(
            tx,
            { listingId: owned.id },
            body.appendLines,
          );
        }
      } else {
        if (body.stockQuantity === undefined) {
          throw new AppError(
            400,
            "stockQuantity is required for manual delivery",
            "VALIDATION_ERROR",
          );
        }
        await tx.listing.update({
          where: { id: owned.id },
          data: { stockQuantity: body.stockQuantity },
        });
      }

      // Reopen SOLD listings when stock returns.
      const refreshed = await tx.listing.findUniqueOrThrow({
        where: { id: owned.id },
        select: {
          id: true,
          status: true,
          listingModel: true,
          stockQuantity: true,
          offers: { select: { stockQuantity: true } },
        },
      });
      const hasStock =
        refreshed.listingModel === "DYNAMIC"
          ? refreshed.offers.some((o) => o.stockQuantity > 0)
          : refreshed.stockQuantity > 0;
      if (refreshed.status === "SOLD" && hasStock) {
        await tx.listing.update({
          where: { id: owned.id },
          data: { status: "ACTIVE" },
        });
      } else if (
        (refreshed.status === "ACTIVE" || refreshed.status === "PAUSED") &&
        !hasStock
      ) {
        await tx.listing.update({
          where: { id: owned.id },
          data: { status: "SOLD" },
        });
      }

      return tx.listing.findUniqueOrThrow({
        where: { id: owned.id },
        select: listingPublicSelect,
      });
    });

    // Attach owner stock items for the dialog refresh.
    const enriched = await withRlsTransaction({ actor }, async (tx) => {
      const payload = { ...listing } as Record<string, unknown>;
      if (listing.listingModel === "DYNAMIC") {
        payload.offers = await Promise.all(
          listing.offers.map(async (offer) => ({
            ...offer,
            autoStockItems:
              offer.deliveryMode === "AUTO"
                ? await loadOwnerAutoStockItems(tx, { offerId: offer.id })
                : [],
            autoStockLines:
              offer.deliveryMode === "AUTO"
                ? await loadOwnerAutoStockLines(tx, { offerId: offer.id })
                : [],
          })),
        );
      } else if (listing.deliveryMode === "AUTO") {
        const items = await loadOwnerAutoStockItems(tx, {
          listingId: listing.id,
        });
        payload.autoStockItems = items;
        payload.autoStockLines = items.map((i) => i.content);
      }
      return payload;
    });

    res.json({ listing: enriched });
  }),
);

listingsRouter.post(
  "/:id/pause",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const updated = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await getOwnedListingTx(tx, routeParam(req.params.id), actor);
      if (listing.status !== "ACTIVE") {
        throw new AppError(
          409,
          "Only active listings can be paused",
          "INVALID_STATUS",
        );
      }
      return tx.listing.update({
        where: { id: listing.id },
        data: { status: "PAUSED" },
        select: listingPublicSelect,
      });
    });
    res.json({ listing: updated });
  }),
);

listingsRouter.post(
  "/:id/unpause",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const updated = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await getOwnedListingTx(tx, routeParam(req.params.id), actor);
      if (listing.status !== "PAUSED") {
        throw new AppError(
          409,
          "Only paused listings can be resumed",
          "INVALID_STATUS",
        );
      }
      return tx.listing.update({
        where: { id: listing.id },
        data: { status: "ACTIVE" },
        select: listingPublicSelect,
      });
    });
    res.json({ listing: updated });
  }),
);

listingsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const updated = await withRlsTransaction({ actor }, async (tx) => {
      const listing = await getOwnedListingTx(tx, routeParam(req.params.id), actor);
      return tx.listing.update({
        where: { id: listing.id },
        data: { status: "REMOVED" },
        select: listingPublicSelect,
      });
    });
    res.json({ listing: updated });
  }),
);

async function getOwnedListingTx(
  tx: Parameters<Parameters<typeof withRlsTransaction>[1]>[0],
  ref: string,
  actor: RlsActor,
) {
  const listing = await tx.listing.findUnique({ where: listingWhereByRef(ref) });
  if (!listing || listing.status === "REMOVED") {
    throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
  }
  if (listing.sellerId !== actor.id && actor.role !== "ADMIN") {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }
  return listing;
}
