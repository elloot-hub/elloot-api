import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { sanitizeUserText } from "../../lib/sanitize";
import type { updateListingSchema } from "./listings.schemas";
import type { z } from "zod";
import {
  assertLeafCategory,
  resolveOwnedListingMedia,
} from "./listings.media";
import {
  syncListingAutoStock,
  syncOfferAutoStock,
  countAvailableStock,
} from "./delivery-stock.service";
import { listingPublicSelect } from "./listings.shared";

type Tx = Prisma.TransactionClient;
type UpdateBody = z.infer<typeof updateListingSchema>;

export type RevisionPayload = {
  categoryId?: string;
  title?: string;
  description?: string;
  productType?: string | null;
  deliveryMode?: "MANUAL" | "AUTO";
  autoStockLines?: string[];
  priceCents?: number;
  stockQuantity?: number;
  mediaAssetIds?: string[];
  mediaUrls?: string[];
  offers?: Array<{
    id?: string;
    title: string;
    priceCents: number;
    stockQuantity?: number;
    deliveryMode?: "MANUAL" | "AUTO";
    autoStockLines?: string[];
  }>;
};

export type SplitUpdateResult = {
  immediate: UpdateBody;
  moderated: RevisionPayload;
  changedFields: string[];
};

type OfferRow = {
  id: string;
  title: string;
  priceCents: number;
  stockQuantity: number;
  deliveryMode: "MANUAL" | "AUTO";
  sortOrder: number;
};

type MediaRow = { url: string; sortOrder: number };

const LIVE_STATUSES = new Set(["ACTIVE", "PAUSED"]);

export function isLiveListingStatus(status: string) {
  return LIVE_STATUSES.has(status);
}

function uniqueFields(fields: string[]) {
  return [...new Set(fields)];
}

function mediaHasNewUrls(incoming: string[], existing: string[]) {
  const existingSet = new Set(existing);
  return incoming.some((url) => !existingSet.has(url));
}

function mediaOrderChanged(incoming: string[], existing: string[]) {
  if (incoming.length !== existing.length) return true;
  return incoming.some((url, i) => url !== existing[i]);
}

export function splitMediaUpdate(
  body: Pick<UpdateBody, "mediaAssetIds" | "mediaUrls">,
  existingUrls: string[],
): {
  immediate: Pick<UpdateBody, "mediaAssetIds" | "mediaUrls"> | null;
  moderated: Pick<UpdateBody, "mediaAssetIds" | "mediaUrls"> | null;
  changedFields: string[];
} {
  if (!body.mediaAssetIds && !body.mediaUrls) {
    return { immediate: null, moderated: null, changedFields: [] };
  }

  const incomingUrls = body.mediaUrls ?? [];
  const hasNew = mediaHasNewUrls(incomingUrls, existingUrls);
  const orderChanged = mediaOrderChanged(incomingUrls, existingUrls);
  const isRemovalOnly =
    incomingUrls.length > 0 &&
    incomingUrls.length < existingUrls.length &&
    !hasNew &&
    incomingUrls.every((url) => existingUrls.includes(url));

  if (isRemovalOnly) {
    return {
      immediate: {
        mediaAssetIds: body.mediaAssetIds,
        mediaUrls: body.mediaUrls,
      },
      moderated: null,
      changedFields: ["media"],
    };
  }

  if (
    body.mediaAssetIds?.length ||
    body.mediaUrls?.length ||
    hasNew ||
    orderChanged
  ) {
    return {
      immediate: null,
      moderated: {
        mediaAssetIds: body.mediaAssetIds,
        mediaUrls: body.mediaUrls,
      },
      changedFields: ["media"],
    };
  }

  return { immediate: null, moderated: null, changedFields: [] };
}

export function splitOffersUpdate(
  incoming: NonNullable<UpdateBody["offers"]>,
  existing: OfferRow[],
): {
  immediate: NonNullable<UpdateBody["offers"]> | null;
  moderated: NonNullable<UpdateBody["offers"]> | null;
  changedFields: string[];
} {
  const existingMap = new Map(existing.map((o) => [o.id, o]));
  const incomingIds = new Set(
    incoming.map((o) => o.id).filter((id): id is string => Boolean(id)),
  );

  let hasModerated = false;
  const fields: string[] = [];

  for (const offer of incoming) {
    if (!offer.id) {
      hasModerated = true;
      fields.push("offers.new");
      continue;
    }
    const prev = existingMap.get(offer.id);
    if (!prev) {
      throw new AppError(400, "Invalid offer id", "OFFER_NOT_FOUND");
    }
    if (offer.title.trim() !== prev.title) {
      hasModerated = true;
      fields.push("offers.title");
    }
    if ((offer.deliveryMode ?? "MANUAL") !== prev.deliveryMode) {
      hasModerated = true;
      fields.push("offers.deliveryMode");
    }
    if (offer.priceCents !== prev.priceCents) fields.push("offers.priceCents");
    if (
      offer.stockQuantity !== undefined &&
      offer.stockQuantity !== prev.stockQuantity
    ) {
      fields.push("offers.stockQuantity");
    }
  }

  for (const prev of existing) {
    if (!incomingIds.has(prev.id)) {
      fields.push("offers.removed");
    }
  }

  if (hasModerated) {
    return {
      immediate: null,
      moderated: incoming,
      changedFields: uniqueFields(fields),
    };
  }

  return {
    immediate: incoming,
    moderated: null,
    changedFields: uniqueFields(fields),
  };
}

export function splitListingUpdate(
  body: UpdateBody,
  listingStatus: string,
  existingOffers: OfferRow[],
  existingMediaUrls: string[],
): SplitUpdateResult {
  if (!isLiveListingStatus(listingStatus)) {
    return {
      immediate: body,
      moderated: {},
      changedFields: Object.keys(body),
    };
  }

  const immediate: UpdateBody = {};
  const moderated: RevisionPayload = {};
  const changedFields: string[] = [];

  const moderatedScalar: Array<keyof RevisionPayload> = [
    "categoryId",
    "title",
    "description",
    "productType",
    "deliveryMode",
  ];

  for (const key of moderatedScalar) {
    if (body[key] !== undefined) {
      moderated[key] = body[key] as never;
      changedFields.push(key);
    }
  }

  if (body.priceCents !== undefined) {
    immediate.priceCents = body.priceCents;
    changedFields.push("priceCents");
  }
  if (body.stockQuantity !== undefined) {
    immediate.stockQuantity = body.stockQuantity;
    changedFields.push("stockQuantity");
  }

  const mediaSplit = splitMediaUpdate(body, existingMediaUrls);
  if (mediaSplit.immediate) {
    immediate.mediaAssetIds = mediaSplit.immediate.mediaAssetIds;
    immediate.mediaUrls = mediaSplit.immediate.mediaUrls;
    changedFields.push(...mediaSplit.changedFields);
  }
  if (mediaSplit.moderated) {
    moderated.mediaAssetIds = mediaSplit.moderated.mediaAssetIds;
    moderated.mediaUrls = mediaSplit.moderated.mediaUrls;
    changedFields.push(...mediaSplit.changedFields);
  }

  if (body.offers !== undefined) {
    const offerSplit = splitOffersUpdate(body.offers, existingOffers);
    if (offerSplit.immediate) {
      immediate.offers = offerSplit.immediate;
      changedFields.push(...offerSplit.changedFields);
    }
    if (offerSplit.moderated) {
      moderated.offers = offerSplit.moderated;
      changedFields.push(...offerSplit.changedFields);
    }
  }

  return {
    immediate,
    moderated,
    changedFields: uniqueFields(changedFields),
  };
}

export async function applyListingMediaTx(
  tx: Tx,
  ownerId: string,
  listingId: string,
  input: { mediaAssetIds?: string[]; mediaUrls?: string[] },
) {
  if (!input.mediaAssetIds && !input.mediaUrls) return;

  const mediaRows = await resolveOwnedListingMedia(tx, ownerId, input);
  await tx.listingMedia.deleteMany({ where: { listingId } });
  if (mediaRows.length) {
    await tx.listingMedia.createMany({
      data: mediaRows.map((row) => ({
        listingId,
        url: row.url,
        sortOrder: row.sortOrder,
      })),
    });
  }
}

export async function applyOffersUpdateTx(
  tx: Tx,
  listingId: string,
  offers: Array<{
    id?: string;
    title: string;
    priceCents: number;
    stockQuantity?: number;
    deliveryMode?: "MANUAL" | "AUTO";
    autoStockLines?: string[];
  }>,
  options?: { priceStockOnly?: boolean },
) {
  const payloadIds = offers
    .map((o) => o.id)
    .filter((id): id is string => Boolean(id));

  const ownedOffers = await tx.listingOffer.findMany({
    where: { listingId },
    select: { id: true, title: true, deliveryMode: true },
  });
  const ownedIds = new Set(ownedOffers.map((o) => o.id));

  for (const offerId of payloadIds) {
    if (!ownedIds.has(offerId)) {
      throw new AppError(400, "Invalid offer id", "OFFER_NOT_FOUND");
    }
  }

  const keepIds = new Set(payloadIds);
  await tx.listingOffer.deleteMany({
    where: {
      listingId,
      ...(keepIds.size ? { id: { notIn: [...keepIds] } } : {}),
    },
  });

  for (const [index, offer] of offers.entries()) {
    const title = sanitizeUserText(offer.title, 120);
    const deliveryMode = offer.deliveryMode ?? "MANUAL";
    let offerId = offer.id;

    if (offer.id) {
      const prev = ownedOffers.find((o) => o.id === offer.id);
      await tx.listingOffer.update({
        where: { id: offer.id },
        data: {
          ...(options?.priceStockOnly ? {} : { title, deliveryMode }),
          priceCents: offer.priceCents,
          ...(offer.stockQuantity !== undefined && deliveryMode === "MANUAL"
            ? { stockQuantity: offer.stockQuantity }
            : {}),
          sortOrder: index,
        },
      });
      if (options?.priceStockOnly && prev) {
        await tx.listingOffer.update({
          where: { id: offer.id },
          data: { title: prev.title, deliveryMode: prev.deliveryMode },
        });
      }
    } else if (!options?.priceStockOnly) {
      const created = await tx.listingOffer.create({
        data: {
          listingId,
          title,
          priceCents: offer.priceCents,
          stockQuantity: offer.stockQuantity ?? 1,
          deliveryMode,
          sortOrder: index,
        },
        select: { id: true },
      });
      offerId = created.id;
    }

    if (
      !options?.priceStockOnly &&
      offer.autoStockLines !== undefined &&
      offerId
    ) {
      if (deliveryMode === "AUTO") {
        await syncOfferAutoStock(tx, offerId, offer.autoStockLines);
      } else {
        await tx.deliveryStockItem.deleteMany({
          where: { offerId, status: "AVAILABLE" },
        });
      }
    }
  }

  const allOffers = await tx.listingOffer.findMany({
    where: { listingId },
    select: { priceCents: true, deliveryMode: true },
  });

  if (!allOffers.length) return null;

  return {
    priceCents: Math.min(...allOffers.map((o) => o.priceCents)),
    deliveryMode: allOffers.some((o) => o.deliveryMode === "AUTO")
      ? ("AUTO" as const)
      : ("MANUAL" as const),
  };
}

export async function applyListingUpdateTx(
  tx: Tx,
  input: {
    ownerId: string;
    listing: {
      id: string;
      listingModel: string;
    };
    body: UpdateBody | RevisionPayload;
  },
) {
  const { ownerId, listing, body } = input;

  if (body.categoryId) {
    await assertLeafCategory(tx, body.categoryId);
  }

  if (body.mediaAssetIds || body.mediaUrls) {
    await applyListingMediaTx(tx, ownerId, listing.id, {
      mediaAssetIds: body.mediaAssetIds,
      mediaUrls: body.mediaUrls,
    });
  }

  let offerDerived: { priceCents: number; deliveryMode: "MANUAL" | "AUTO" } | null =
    null;

  if (body.offers !== undefined) {
    if (listing.listingModel !== "DYNAMIC") {
      throw new AppError(
        400,
        "Offers can only be updated on dynamic listings",
        "INVALID_LISTING_MODEL",
      );
    }
    offerDerived = await applyOffersUpdateTx(tx, listing.id, body.offers);
  }

  if (
    body.autoStockLines !== undefined &&
    listing.listingModel !== "DYNAMIC"
  ) {
    await syncListingAutoStock(tx, listing.id, body.autoStockLines);
  }

  const listingStockQty =
    body.autoStockLines !== undefined && listing.listingModel !== "DYNAMIC"
      ? await countAvailableStock(tx, { listingId: listing.id })
      : body.stockQuantity;

  return tx.listing.update({
    where: { id: listing.id },
    data: {
      categoryId: body.categoryId,
      title: body.title ? sanitizeUserText(body.title, 120) : undefined,
      description: body.description
        ? sanitizeUserText(body.description, 5000)
        : undefined,
      productType: body.productType,
      priceCents: body.priceCents ?? offerDerived?.priceCents,
      stockQuantity: listingStockQty,
      deliveryMode: body.deliveryMode ?? offerDerived?.deliveryMode,
    },
    select: listingPublicSelect,
  });
}

export async function applyImmediateOffersOnlyTx(
  tx: Tx,
  listingId: string,
  listingModel: string,
  offers: NonNullable<UpdateBody["offers"]>,
) {
  if (listingModel !== "DYNAMIC") {
    throw new AppError(
      400,
      "Offers can only be updated on dynamic listings",
      "INVALID_LISTING_MODEL",
    );
  }
  const derived = await applyOffersUpdateTx(tx, listingId, offers, {
    priceStockOnly: true,
  });
  if (!derived) return null;
  return tx.listing.update({
    where: { id: listingId },
    data: {
      priceCents: derived.priceCents,
      deliveryMode: derived.deliveryMode,
    },
    select: listingPublicSelect,
  });
}

export async function upsertPendingRevisionTx(
  tx: Tx,
  listingId: string,
  payload: RevisionPayload,
  changedFields: string[],
) {
  const existing = await tx.listingModerationQueue.findFirst({
    where: { listingId, status: "PENDING", type: "REVISION" },
    select: { id: true, payload: true, changedFields: true },
  });

  if (existing) {
    const mergedPayload = {
      ...(existing.payload as RevisionPayload),
      ...payload,
    };
    const mergedFields = uniqueFields([
      ...existing.changedFields,
      ...changedFields,
    ]);

    try {
      return await tx.listingModerationQueue.update({
        where: { id: existing.id },
        data: {
          payload: mergedPayload as Prisma.InputJsonValue,
          changedFields: mergedFields,
        },
      });
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "";
      if (code !== "P2025") throw err;
      await tx.listingModerationQueue.updateMany({
        where: { listingId, status: "PENDING", type: "REVISION" },
        data: { status: "SUPERSEDED" },
      });
    }
  }

  return tx.listingModerationQueue.create({
    data: {
      listingId,
      type: "REVISION",
      status: "PENDING",
      payload: payload as Prisma.InputJsonValue,
      changedFields,
    },
  });
}

export async function submitListingForReviewTx(tx: Tx, listingId: string) {
  const listing = await tx.listing.findUnique({
    where: { id: listingId },
    select: { id: true, status: true },
  });
  if (!listing) {
    throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
  }
  if (listing.status === "SOLD") {
    throw new AppError(409, "Listing already sold", "LISTING_SOLD");
  }
  if (listing.status === "ACTIVE") {
    throw new AppError(409, "Listing is already active", "INVALID_STATUS");
  }
  if (listing.status === "PENDING_REVIEW") {
    throw new AppError(
      409,
      "Listing is already pending review",
      "ALREADY_PENDING",
    );
  }

  await tx.listingModerationQueue.updateMany({
    where: {
      listingId,
      type: "INITIAL",
      status: "PENDING",
    },
    data: { status: "SUPERSEDED" },
  });

  await tx.listingModerationQueue.create({
    data: {
      listingId,
      type: "INITIAL",
      status: "PENDING",
      payload: {},
      changedFields: ["initial"],
    },
  });

  return tx.listing.update({
    where: { id: listingId },
    data: {
      status: "PENDING_REVIEW",
      moderationNote: null,
      submittedForReviewAt: new Date(),
    },
    select: listingPublicSelect,
  });
}

export async function approveModerationTx(
  tx: Tx,
  queueId: string,
  reviewerId: string,
) {
  const item = await tx.listingModerationQueue.findUnique({
    where: { id: queueId },
    include: {
      listing: {
        select: {
          id: true,
          sellerId: true,
          listingModel: true,
          status: true,
        },
      },
    },
  });

  if (!item || item.status !== "PENDING") {
    throw new AppError(404, "Moderation item not found", "NOT_FOUND");
  }

  if (item.type === "INITIAL") {
    await tx.listing.update({
      where: { id: item.listingId },
      data: {
        status: "ACTIVE",
        moderationNote: null,
      },
    });
  } else {
    const payload = item.payload as RevisionPayload;
    await applyListingUpdateTx(tx, {
      ownerId: item.listing.sellerId,
      listing: item.listing,
      body: payload,
    });
  }

  const updated = await tx.listingModerationQueue.update({
    where: { id: queueId },
    data: {
      status: "APPROVED",
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: reviewerId,
      action: "listing.moderation.approved",
      entityType: "ListingModerationQueue",
      entityId: queueId,
      meta: {
        listingId: item.listingId,
        type: item.type,
      },
    },
  });

  return updated;
}

export async function rejectModerationTx(
  tx: Tx,
  queueId: string,
  reviewerId: string,
  reviewNote: string,
) {
  const item = await tx.listingModerationQueue.findUnique({
    where: { id: queueId },
    select: { id: true, listingId: true, type: true, status: true },
  });

  if (!item || item.status !== "PENDING") {
    throw new AppError(404, "Moderation item not found", "NOT_FOUND");
  }

  const note = sanitizeUserText(reviewNote, 1000);

  if (item.type === "INITIAL") {
    await tx.listing.update({
      where: { id: item.listingId },
      data: {
        status: "REJECTED",
        moderationNote: note,
      },
    });
  }

  const updated = await tx.listingModerationQueue.update({
    where: { id: queueId },
    data: {
      status: "REJECTED",
      reviewNote: note,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: reviewerId,
      action: "listing.moderation.rejected",
      entityType: "ListingModerationQueue",
      entityId: queueId,
      meta: {
        listingId: item.listingId,
        type: item.type,
        reviewNote: note,
      },
    },
  });

  return updated;
}

export type ListingSnapshot = {
  categoryId: string;
  title: string;
  description: string;
  priceCents: number;
  stockQuantity: number;
  productType: string | null;
  listingModel: string;
  deliveryMode: string;
  media: MediaRow[];
  offers: OfferRow[];
};

export async function loadListingSnapshotTx(
  tx: Tx,
  listingId: string,
): Promise<ListingSnapshot | null> {
  return tx.listing.findUnique({
    where: { id: listingId },
    select: {
      categoryId: true,
      title: true,
      description: true,
      priceCents: true,
      stockQuantity: true,
      productType: true,
      listingModel: true,
      deliveryMode: true,
      media: {
        orderBy: { sortOrder: "asc" },
        select: { url: true, sortOrder: true },
      },
      offers: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          title: true,
          priceCents: true,
          stockQuantity: true,
          deliveryMode: true,
          sortOrder: true,
        },
      },
    },
  });
}

export function buildProposedSnapshot(
  live: ListingSnapshot,
  payload: RevisionPayload,
): ListingSnapshot {
  const proposed: ListingSnapshot = {
    ...live,
    categoryId: payload.categoryId ?? live.categoryId,
    title: payload.title ?? live.title,
    description: payload.description ?? live.description,
    productType:
      payload.productType !== undefined ? payload.productType : live.productType,
    deliveryMode: payload.deliveryMode ?? live.deliveryMode,
    media: live.media,
    offers: live.offers,
  };

  if (payload.mediaUrls) {
    proposed.media = payload.mediaUrls.map((url, sortOrder) => ({
      url,
      sortOrder,
    }));
  }

  if (payload.offers) {
    proposed.offers = payload.offers.map((offer, sortOrder) => ({
      id: offer.id ?? `new-${sortOrder}`,
      title: offer.title,
      priceCents: offer.priceCents,
      stockQuantity: offer.stockQuantity ?? 1,
      deliveryMode: offer.deliveryMode ?? "MANUAL",
      sortOrder,
    }));
    proposed.priceCents = Math.min(...payload.offers.map((o) => o.priceCents));
    proposed.deliveryMode = payload.offers.some((o) => o.deliveryMode === "AUTO")
      ? "AUTO"
      : "MANUAL";
  }

  if (payload.priceCents !== undefined) {
    proposed.priceCents = payload.priceCents;
  }
  if (payload.stockQuantity !== undefined) {
    proposed.stockQuantity = payload.stockQuantity;
  }

  return proposed;
}

export function diffSnapshots(live: ListingSnapshot, proposed: ListingSnapshot) {
  const fields: Array<{ field: string; before: unknown; after: unknown }> = [];

  const scalarKeys: Array<keyof ListingSnapshot> = [
    "categoryId",
    "title",
    "description",
    "priceCents",
    "stockQuantity",
    "productType",
    "deliveryMode",
  ];

  for (const key of scalarKeys) {
    if (live[key] !== proposed[key]) {
      fields.push({ field: key, before: live[key], after: proposed[key] });
    }
  }

  const liveMedia = live.media.map((m) => m.url).join("|");
  const proposedMedia = proposed.media.map((m) => m.url).join("|");
  if (liveMedia !== proposedMedia) {
    fields.push({
      field: "media",
      before: live.media.map((m) => m.url),
      after: proposed.media.map((m) => m.url),
    });
  }

  const serializeOffers = (offers: OfferRow[]) =>
    offers.map((o) => ({
      id: o.id,
      title: o.title,
      priceCents: o.priceCents,
      stockQuantity: o.stockQuantity,
      deliveryMode: o.deliveryMode,
    }));

  const liveOffers = JSON.stringify(serializeOffers(live.offers));
  const proposedOffers = JSON.stringify(serializeOffers(proposed.offers));
  if (liveOffers !== proposedOffers) {
    fields.push({
      field: "offers",
      before: serializeOffers(live.offers),
      after: serializeOffers(proposed.offers),
    });
  }

  return fields;
}

export async function getPendingModerationForListingTx(tx: Tx, listingId: string) {
  return tx.listingModerationQueue.findFirst({
    where: { listingId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      status: true,
      changedFields: true,
      reviewNote: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export const moderationQueueListSelect = {
  id: true,
  listingId: true,
  type: true,
  status: true,
  changedFields: true,
  reviewNote: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
  listing: {
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      priceCents: true,
      listingModel: true,
      deliveryMode: true,
      productType: true,
      submittedForReviewAt: true,
      moderationNote: true,
      createdAt: true,
      seller: {
        select: {
          id: true,
          name: true,
          email: true,
          kycStatus: true,
        },
      },
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
      media: {
        orderBy: { sortOrder: "asc" as const },
        take: 1,
        select: { url: true },
      },
    },
  },
} satisfies Prisma.ListingModerationQueueSelect;

export function serializeModerationQueueItem(
  row: Prisma.ListingModerationQueueGetPayload<{
    select: typeof moderationQueueListSelect;
  }>,
) {
  const ageHours = Math.max(
    0,
    (Date.now() - row.createdAt.getTime()) / 3_600_000,
  );
  return {
    id: row.id,
    listingId: row.listingId,
    type: row.type,
    status: row.status,
    changedFields: row.changedFields,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ageHours,
    listing: {
      id: row.listing.id,
      code: row.listing.code,
      title: row.listing.title,
      status: row.listing.status,
      priceCents: row.listing.priceCents,
      listingModel: row.listing.listingModel,
      deliveryMode: row.listing.deliveryMode,
      productType: row.listing.productType,
      submittedForReviewAt:
        row.listing.submittedForReviewAt?.toISOString() ?? null,
      moderationNote: row.listing.moderationNote,
      createdAt: row.listing.createdAt.toISOString(),
      coverUrl: row.listing.media[0]?.url ?? null,
      seller: row.listing.seller,
      category: row.listing.category,
    },
  };
}
