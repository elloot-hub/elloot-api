import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { routeParam } from "../../lib/route-param";
import { requireAuth } from "../../middleware/auth";
import { createOrderCheckout } from "../payments/payment.checkout";
import { cancelOrderByBuyer } from "./orders.lifecycle";
import {
  confirmOrderByBuyer,
  createOrderFromListing,
  markOrderDelivered,
} from "./orders.service";
import {
  SELLER_METRIC_RANGES,
  aggregateSellerMetrics,
  loadPriorBuyerIds,
  loadSellerMetricOrders,
  previousWindow,
  rangeWindow,
  windowFromDates,
} from "./orders.metrics";
import {
  aggregateFunnelFromEvents,
  loadSellerListingEvents,
} from "../listings/listings.events";
import { isOrderCode } from "../../lib/public-codes";
import { orderWhereByRef } from "./order-ref";

export const ordersRouter = Router();

const createOrderSchema = z.object({
  listingId: z.string().min(1),
  offerId: z.string().min(1).optional(),
});

const orderSelect = {
  id: true,
  code: true,
  status: true,
  amountCents: true,
  feeCents: true,
  offerId: true,
  paidAt: true,
  deliveredAt: true,
  deliveryContent: true,
  completedAt: true,
  expiresAt: true,
  createdAt: true,
  listing: {
    select: {
      id: true,
      code: true,
      title: true,
      priceCents: true,
      deliveryMode: true,
      media: {
        take: 1,
        orderBy: { sortOrder: "asc" as const },
        select: { url: true },
      },
    },
  },
  offer: {
    select: {
      id: true,
      title: true,
      priceCents: true,
      deliveryMode: true,
    },
  },
  buyer: { select: { id: true, name: true, email: true } },
  seller: { select: { id: true, name: true, email: true } },
  payment: {
    select: {
      id: true,
      provider: true,
      providerRef: true,
      status: true,
      amountCents: true,
    },
  },
  escrowHold: {
    select: {
      amountCents: true,
      releaseAt: true,
      releasedAt: true,
    },
  },
  conversation: { select: { id: true } },
  review: {
    select: {
      id: true,
      rating: true,
      comment: true,
      createdAt: true,
    },
  },
  dispute: {
    select: {
      id: true,
      code: true,
      openedById: true,
      reason: true,
      status: true,
      resolution: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} as const;

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

ordersRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = createOrderSchema.parse(req.body);
    const actor = actorOf(req);
    const order = await createOrderFromListing({
      listingId: body.listingId,
      offerId: body.offerId,
      buyerId: actor.id,
      actor,
    });
    const checkout = await createOrderCheckout(order.id, actor);
    const full = await withRlsTransaction({ actor }, (tx) =>
      tx.order.findUniqueOrThrow({ where: { id: order.id }, select: orderSelect }),
    );
    res.status(201).json({ order: full, checkout });
  }),
);

const mineQuerySchema = z.object({
  role: z.enum(["buyer", "seller", "all"]).optional().default("all"),
  status: z
    .enum([
      "PENDING_PAYMENT",
      "PAID",
      "DELIVERED",
      "COMPLETED",
      "CANCELLED",
      "EXPIRED",
      "DISPUTED",
      "REFUNDED",
    ])
    .optional(),
  q: z.string().trim().max(80).optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(50),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const metricsQuerySchema = z.object({
  range: z.enum(SELLER_METRIC_RANGES).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

ordersRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = mineQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const dateWindow =
      query.from && query.to ? windowFromDates(query.from, query.to) : null;
    const orders = await withRlsTransaction({ actor }, (tx) =>
      tx.order.findMany({
        where: {
          ...(query.role === "seller"
            ? { sellerId: actor.id }
            : query.role === "buyer"
              ? { buyerId: actor.id }
              : { OR: [{ buyerId: actor.id }, { sellerId: actor.id }] }),
          ...(query.status ? { status: query.status } : {}),
          ...(query.q
            ? isOrderCode(query.q)
              ? { code: query.q.toUpperCase() }
              : {
                  OR: [
                    {
                      code: {
                        contains: query.q,
                        mode: "insensitive" as const,
                      },
                    },
                    {
                      listing: {
                        title: { contains: query.q, mode: "insensitive" as const },
                      },
                    },
                  ],
                }
            : {}),
          ...(dateWindow
            ? { createdAt: { gte: dateWindow.start, lte: dateWindow.end } }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: query.take,
        select: orderSelect,
      }),
    );
    res.json({ orders });
  }),
);

ordersRouter.get(
  "/seller/metrics",
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = metricsQuerySchema.parse(req.query);
    const actor = actorOf(req);
    const window =
      query.from && query.to
        ? windowFromDates(query.from, query.to)
        : rangeWindow(query.range ?? "30d");
    if (!window) {
      throw new AppError(400, "Invalid date range", "INVALID_RANGE");
    }

    const previous = previousWindow(window);

    const metrics = await withRlsTransaction({ actor }, async (tx) => {
      const [
        orders,
        previousOrders,
        priorBuyerIds,
        activeListings,
        currentEvents,
        previousEvents,
      ] = await Promise.all([
        loadSellerMetricOrders(tx, actor.id, window.start, window.end),
        loadSellerMetricOrders(tx, actor.id, previous.start, previous.end),
        loadPriorBuyerIds(tx, actor.id, window.start),
        tx.listing.count({
          where: { sellerId: actor.id, status: "ACTIVE" },
        }),
        loadSellerListingEvents(tx, actor.id, window.start, window.end),
        loadSellerListingEvents(tx, actor.id, previous.start, previous.end),
      ]);

      const currentFunnel = aggregateFunnelFromEvents(currentEvents);
      const previousFunnel = aggregateFunnelFromEvents(previousEvents);

      const titleIds = new Set<string>([
        ...orders.map((o) => o.listing.id),
        ...currentFunnel.byListing.keys(),
      ]);
      const titleRows =
        titleIds.size > 0
          ? await tx.listing.findMany({
              where: { id: { in: [...titleIds] }, sellerId: actor.id },
              select: { id: true, title: true },
            })
          : [];
      const listingTitles = new Map(titleRows.map((row) => [row.id, row.title]));

      return aggregateSellerMetrics(
        orders,
        previousOrders,
        priorBuyerIds,
        currentFunnel,
        previousFunnel,
        window,
        previous,
        activeListings,
        listingTitles,
      );
    });

    res.json({ metrics });
  }),
);

ordersRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ref = routeParam(req.params.id);
    const actor = actorOf(req);
    const order = await withRlsTransaction({ actor }, (tx) =>
      tx.order.findUnique({ where: orderWhereByRef(ref), select: orderSelect }),
    );
    if (!order) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    res.json({ order });
  }),
);

ordersRouter.post(
  "/:id/checkout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const actor = actorOf(req);
    const checkout = await createOrderCheckout(id, actor);
    res.json({ checkout });
  }),
);

ordersRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const order = await cancelOrderByBuyer(
      routeParam(req.params.id),
      actor.id,
      actor,
    );
    const full = await withRlsTransaction({ actor }, (tx) =>
      tx.order.findUniqueOrThrow({ where: { id: order.id }, select: orderSelect }),
    );
    res.json({ order: full });
  }),
);

ordersRouter.post(
  "/:id/deliver",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const order = await markOrderDelivered(
      routeParam(req.params.id),
      actor.id,
      actor,
    );
    const full = await withRlsTransaction({ actor }, (tx) =>
      tx.order.findUniqueOrThrow({ where: { id: order.id }, select: orderSelect }),
    );
    res.json({ order: full });
  }),
);

ordersRouter.post(
  "/:id/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const order = await confirmOrderByBuyer(
      routeParam(req.params.id),
      actor.id,
      actor,
    );
    const full = await withRlsTransaction({ actor }, (tx) =>
      tx.order.findUniqueOrThrow({ where: { id: order.id }, select: orderSelect }),
    );
    res.json({ order: full });
  }),
);
