import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { createWithPublicCode } from "../../lib/create-with-code";
import {
  lockListingForUpdate,
  lockOfferForUpdate,
  lockOrderForUpdate,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { completeOrderTx } from "./orders.lifecycle";
import { calcFeeCents } from "./orders.fees";
import {
  tryReserveListing,
} from "./orders.reserve";
import { routes } from "../conversations/hrefs";
import { notifyUser } from "../conversations/notifications.notify";
import {
  reconcileAutoStockQuantity,
  reserveAutoStockForOrder,
} from "../listings/delivery-stock.service";

export { calcFeeCents };

/**
 * Create order under service RLS context so FOR UPDATE can see competing
 * checkouts on the same listing (user-scoped RLS would hide them).
 *
 * Stock is reserved (decremented) here and restored on cancel/expire/refund.
 * DYNAMIC listings require `offerId` and use the offer price/stock.
 */
export async function createOrderFromListing(input: {
  listingId: string;
  buyerId: string;
  actor: RlsActor;
  offerId?: string | null;
}) {
  if (input.actor.id !== input.buyerId) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  return withServiceTransaction(async (tx) => {
    const listing = await lockListingForUpdate(tx, input.listingId);

    if (!listing || listing.status !== "ACTIVE") {
      throw new AppError(404, "Listing unavailable", "LISTING_UNAVAILABLE");
    }
    if (listing.sellerId === input.buyerId) {
      throw new AppError(400, "You cannot buy your own listing", "SELF_PURCHASE");
    }

    let amountCents = listing.priceCents;
    let offerId: string | null = null;
    let deliveryMode = listing.deliveryMode as "MANUAL" | "AUTO";

    if (listing.listingModel === "DYNAMIC") {
      if (!input.offerId) {
        throw new AppError(
          400,
          "Select an offer for this listing",
          "OFFER_REQUIRED",
        );
      }
      const offer = await lockOfferForUpdate(tx, input.offerId);
      if (!offer || offer.listingId !== listing.id) {
        throw new AppError(404, "Offer not found", "OFFER_NOT_FOUND");
      }
      deliveryMode = offer.deliveryMode as "MANUAL" | "AUTO";

      if (deliveryMode === "AUTO") {
        const available = await reconcileAutoStockQuantity(tx, {
          listingId: listing.id,
          offerId: offer.id,
        });
        if (available < 1) {
          throw new AppError(
            409,
            "Este anúncio não tem chaves de entrega automática disponíveis. O vendedor precisa recarregar o estoque automático.",
            "AUTO_STOCK_UNAVAILABLE",
          );
        }
      } else if (offer.stockQuantity < 1) {
        throw new AppError(409, "Offer out of stock", "OUT_OF_STOCK");
      }

      await tx.listingOffer.update({
        where: { id: offer.id },
        data: { stockQuantity: { decrement: 1 } },
      });
      amountCents = offer.priceCents;
      offerId = offer.id;
    } else {
      if (input.offerId) {
        throw new AppError(
          400,
          "This listing does not use offers",
          "OFFER_NOT_ALLOWED",
        );
      }

      if (deliveryMode === "AUTO") {
        const available = await reconcileAutoStockQuantity(tx, {
          listingId: listing.id,
        });
        if (available < 1) {
          throw new AppError(
            409,
            "Este anúncio não tem chaves de entrega automática disponíveis. O vendedor precisa recarregar o estoque automático.",
            "AUTO_STOCK_UNAVAILABLE",
          );
        }
      } else if (listing.stockQuantity < 1) {
        throw new AppError(409, "Listing out of stock", "OUT_OF_STOCK");
      }

      await tx.listing.update({
        where: { id: listing.id },
        data: { stockQuantity: { decrement: 1 } },
      });
      amountCents = listing.priceCents;
    }

    const feeCents = calcFeeCents(amountCents, listing.feeBps);
    const expiresAt = new Date(Date.now() + env.CHECKOUT_RESERVE_SECONDS * 1000);

    const order = await createWithPublicCode({
      kind: "ORD",
      create: (code) =>
        tx.order.create({
          data: {
            code,
            listingId: listing.id,
            offerId,
            buyerId: input.buyerId,
            sellerId: listing.sellerId,
            amountCents,
            feeCents,
            status: "PENDING_PAYMENT",
            expiresAt,
          },
        }),
    });

    if (deliveryMode === "AUTO") {
      await reserveAutoStockForOrder(
        tx,
        { id: order.id, listingId: listing.id, offerId },
        deliveryMode,
      );
    }

    // Soft signal for last-unit / ops tooling; stock is the source of truth.
    await tryReserveListing(listing.id, order.id);

    return order;
  }, input.actor);
}

export async function markOrderDelivered(
  orderId: string,
  sellerId: string,
  actor: RlsActor,
) {
  if (actor.id !== sellerId && actor.role !== "ADMIN") {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  const order = await withServiceTransaction(async (tx) => {
    const locked = await lockOrderForUpdate(tx, orderId);
    if (!locked) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    if (locked.sellerId !== sellerId && actor.role !== "ADMIN") {
      throw new AppError(403, "Forbidden", "FORBIDDEN");
    }
    if (locked.status !== "PAID") {
      throw new AppError(409, "Order is not awaiting delivery", "INVALID_STATUS");
    }

    return tx.order.update({
      where: { id: locked.id },
      data: { status: "DELIVERED", deliveredAt: new Date() },
    });
  }, actor);

  void notifyUser({
    userId: order.buyerId,
    type: "ORDER",
    title: "Pedido entregue",
    body: "O vendedor marcou seu pedido como entregue. Confirme o recebimento.",
    href: routes.order(order.code),
    meta: { orderId: order.id, orderCode: order.code },
  });

  return order;
}

export async function confirmOrderByBuyer(
  orderId: string,
  buyerId: string,
  actor: RlsActor,
) {
  if (actor.id !== buyerId) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  const order = await withServiceTransaction(async (tx) => {
    const locked = await lockOrderForUpdate(tx, orderId);
    if (!locked) throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
    if (locked.buyerId !== buyerId) {
      throw new AppError(403, "Forbidden", "FORBIDDEN");
    }
    if (locked.status !== "DELIVERED") {
      throw new AppError(
        409,
        "Confirme apenas após o vendedor marcar como entregue",
        "INVALID_STATUS",
      );
    }

    await completeOrderTx(tx, locked.id);
    return locked;
  }, actor);

  void notifyUser({
    userId: order.sellerId,
    type: "ORDER",
    title: "Pedido confirmado",
    body: "O comprador confirmou o recebimento. O valor será liberado na sua carteira.",
    href: routes.dashboardSales,
    meta: { orderId: order.id, orderCode: order.code },
  });

  return order;
}

export async function completeOrder(orderId: string, actor?: RlsActor | null) {
  return withServiceTransaction(async (tx) => completeOrderTx(tx, orderId), actor);
}
