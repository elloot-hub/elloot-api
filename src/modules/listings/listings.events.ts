import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { withServiceTransaction } from "../../databases";
import { listingWhereByRef } from "./listing-ref";

export const listingEventBodySchema = z.object({
  type: z.enum(["VIEW", "PURCHASE_INTENT"]),
  visitorKey: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
});

const VIEW_DEDUPE_MS = 30 * 60 * 1000;
const INTENT_DEDUPE_MS = 5 * 60 * 1000;

export async function recordListingEvent(input: {
  listingId: string;
  type: "VIEW" | "PURCHASE_INTENT";
  visitorKey: string;
  viewerUserId?: string | null;
  amountCents?: number;
}) {
  return withServiceTransaction(async (tx) => {
    const listing = await tx.listing.findUnique({
      where: listingWhereByRef(input.listingId),
      select: {
        id: true,
        sellerId: true,
        status: true,
        priceCents: true,
      },
    });

    if (!listing || listing.status === "REMOVED") {
      throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
    }

    if (listing.status !== "ACTIVE") {
      return { recorded: false as const, reason: "inactive" as const };
    }

    if (input.viewerUserId && input.viewerUserId === listing.sellerId) {
      return { recorded: false as const, reason: "own_listing" as const };
    }

    const dedupeMs =
      input.type === "VIEW" ? VIEW_DEDUPE_MS : INTENT_DEDUPE_MS;
    const since = new Date(Date.now() - dedupeMs);

    const recent = await tx.listingEvent.findFirst({
      where: {
        listingId: listing.id,
        type: input.type,
        visitorKey: input.visitorKey,
        createdAt: { gte: since },
      },
      select: { id: true },
    });

    if (recent) {
      return { recorded: false as const, reason: "deduped" as const };
    }

    const amountCents =
      input.type === "PURCHASE_INTENT"
        ? (input.amountCents ?? listing.priceCents)
        : null;

    await tx.listingEvent.create({
      data: {
        listingId: listing.id,
        sellerId: listing.sellerId,
        type: input.type,
        visitorKey: input.visitorKey,
        viewerUserId: input.viewerUserId ?? null,
        amountCents,
      },
    });

    return { recorded: true as const };
  });
}

export type ListingEventRow = {
  listingId: string;
  type: "VIEW" | "PURCHASE_INTENT";
  visitorKey: string;
  amountCents: number | null;
  createdAt: Date;
};

export async function loadSellerListingEvents(
  tx: Prisma.TransactionClient,
  sellerId: string,
  start: Date,
  end: Date,
): Promise<ListingEventRow[]> {
  return tx.listingEvent.findMany({
    where: {
      sellerId,
      createdAt: { gte: start, lte: end },
    },
    select: {
      listingId: true,
      type: true,
      visitorKey: true,
      amountCents: true,
      createdAt: true,
    },
    take: 50_000,
    orderBy: { createdAt: "asc" },
  });
}

export function aggregateFunnelFromEvents(events: ListingEventRow[]) {
  const viewKeys = new Set<string>();
  const intentKeys = new Set<string>();
  let intentCount = 0;
  let intentCents = 0;
  const byListing = new Map<
    string,
    { uniqueVisits: number; intentCount: number; intentCents: number; viewKeys: Set<string> }
  >();

  for (const event of events) {
    let row = byListing.get(event.listingId);
    if (!row) {
      row = {
        uniqueVisits: 0,
        intentCount: 0,
        intentCents: 0,
        viewKeys: new Set(),
      };
      byListing.set(event.listingId, row);
    }

    if (event.type === "VIEW") {
      if (!viewKeys.has(event.visitorKey)) viewKeys.add(event.visitorKey);
      if (!row.viewKeys.has(event.visitorKey)) {
        row.viewKeys.add(event.visitorKey);
        row.uniqueVisits += 1;
      }
    } else {
      intentCount += 1;
      intentCents += event.amountCents ?? 0;
      intentKeys.add(event.visitorKey);
      row.intentCount += 1;
      row.intentCents += event.amountCents ?? 0;
    }
  }

  return {
    uniqueVisits: viewKeys.size,
    purchaseIntents: intentCount,
    uniquePurchaseIntents: intentKeys.size,
    purchaseIntentCents: intentCents,
    byListing,
  };
}
