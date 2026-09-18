import { z } from "zod";

const MIN_PRICE_CENTS = 150;

const autoStockLinesSchema = z
  .array(z.string().trim().min(1).max(2000))
  .max(10_000)
  .optional();

const listingOfferSchema = z.object({
  title: z.string().trim().min(2).max(120),
  priceCents: z.number().int().min(MIN_PRICE_CENTS).max(50_000_000),
  stockQuantity: z.number().int().positive().max(1_000_000).optional().default(1),
  deliveryMode: z.enum(["MANUAL", "AUTO"]).optional().default("MANUAL"),
  autoStockLines: autoStockLinesSchema,
});

export const createListingSchema = z
  .object({
    categoryId: z.string().min(1),
    title: z.string().trim().min(5).max(120),
    description: z.string().trim().min(20).max(5000),
    priceCents: z.number().int().min(MIN_PRICE_CENTS).max(50_000_000).optional(),
    stockQuantity: z.number().int().positive().max(1_000_000).optional().default(1),
    productType: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
      .optional()
      .nullable(),
    listingModel: z.enum(["NORMAL", "DYNAMIC", "SERVICE"]).optional().default("NORMAL"),
    deliveryMode: z.enum(["MANUAL", "AUTO"]).optional().default("MANUAL"),
    autoStockLines: autoStockLinesSchema,
    /** Preferred: MediaAsset ids owned by the seller (purpose LISTING). */
    mediaAssetIds: z.array(z.string().min(1)).max(8).optional().default([]),
    /**
     * @deprecated Prefer mediaAssetIds. Still accepted only when each URL
     * maps to an owned LISTING MediaAsset.
     */
    mediaUrls: z.array(z.url()).max(8).optional().default([]),
    publish: z.boolean().optional().default(false),
    offers: z.array(listingOfferSchema).min(2).max(30).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.listingModel === "DYNAMIC") {
      if (!data.offers || data.offers.length < 2) {
        ctx.addIssue({
          code: "custom",
          message: "Dynamic listings require at least 2 offers",
          path: ["offers"],
        });
      }
      return;
    }
    if (data.listingModel === "SERVICE") {
      if (data.priceCents == null || data.priceCents < MIN_PRICE_CENTS) {
        ctx.addIssue({
          code: "custom",
          message: "Service listings require a starting price",
          path: ["priceCents"],
        });
      }
      return;
    }
    if (data.priceCents == null || data.priceCents < MIN_PRICE_CENTS) {
      ctx.addIssue({
        code: "custom",
        message: "priceCents is required",
        path: ["priceCents"],
      });
    }
  });

const updateListingOfferSchema = listingOfferSchema.extend({
  id: z.string().min(1).optional(),
});

export const updateListingSchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    title: z.string().trim().min(5).max(120).optional(),
    description: z.string().trim().min(20).max(5000).optional(),
    priceCents: z.number().int().min(MIN_PRICE_CENTS).max(50_000_000).optional(),
    stockQuantity: z.number().int().positive().max(1_000_000).optional(),
    productType: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
      .optional()
      .nullable(),
    deliveryMode: z.enum(["MANUAL", "AUTO"]).optional(),
    autoStockLines: autoStockLinesSchema,
    mediaAssetIds: z.array(z.string().min(1)).max(8).optional(),
    mediaUrls: z.array(z.url()).max(8).optional(),
    offers: z.array(updateListingOfferSchema).min(2).max(30).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  })
  .superRefine((data, ctx) => {
    if (data.offers && data.offers.length < 2) {
      ctx.addIssue({
        code: "custom",
        message: "Dynamic listings require at least 2 offers",
        path: ["offers"],
      });
    }
  });

export const reorderOffersSchema = z.object({
  offerIds: z.array(z.string().min(1)).min(1).max(30),
});

export const updateListingStockSchema = z
  .object({
    offerId: z.string().min(1).optional(),
    /** Manual delivery: set absolute stock quantity. */
    stockQuantity: z.number().int().min(0).max(1_000_000).optional(),
    /** Auto delivery: append new key lines. */
    appendLines: z
      .array(z.string().trim().min(1).max(2000))
      .max(10_000)
      .optional(),
    /** Auto delivery: remove AVAILABLE item ids. */
    removeItemIds: z.array(z.string().min(1)).max(10_000).optional(),
    /** Auto delivery: replace all AVAILABLE lines. */
    replaceLines: z
      .array(z.string().trim().min(1).max(2000))
      .max(10_000)
      .optional(),
  })
  .refine(
    (data) =>
      data.stockQuantity !== undefined ||
      data.appendLines !== undefined ||
      data.removeItemIds !== undefined ||
      data.replaceLines !== undefined,
    { message: "Provide at least one stock change" },
  );
