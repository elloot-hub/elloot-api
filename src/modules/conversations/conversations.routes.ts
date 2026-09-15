import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { requireAuth } from "../../middleware/auth";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { isUserOnline } from "../../realtime/presence";
import {
  sendConversationMessage,
  markConversationRead,
  messageSelect,
} from "./conversations.service";
import { findConversationIdByRef } from "./conversation-ref";
import { findOrderIdByRef } from "../orders/order-ref";

export const conversationsRouter = Router();

const sendSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  clientId: z.string().trim().min(8).max(64).optional(),
});

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

const conversationSelect = {
  id: true,
  orderId: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  buyerLastReadAt: true,
  sellerLastReadAt: true,
  adminLastReadAt: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      amountCents: true,
      buyerId: true,
      sellerId: true,
      listing: {
        select: {
          id: true,
          title: true,
          media: {
            take: 1,
            orderBy: { sortOrder: "asc" as const },
            select: { url: true },
          },
        },
      },
      buyer: { select: { id: true, name: true, avatarUrl: true } },
      seller: { select: { id: true, name: true, avatarUrl: true } },
    },
  },
} as const;

function serializeConversationTimestamps(row: {
  buyerLastReadAt: Date | null;
  sellerLastReadAt: Date | null;
  adminLastReadAt: Date | null;
}) {
  return {
    buyerLastReadAt: row.buyerLastReadAt?.toISOString() ?? null,
    sellerLastReadAt: row.sellerLastReadAt?.toISOString() ?? null,
    adminLastReadAt: row.adminLastReadAt?.toISOString() ?? null,
  };
}

async function assertConversationParty(
  actor: RlsActor,
  conversationId: string,
) {
  const conversation = await withRlsTransaction({ actor }, (tx) =>
    tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        order: { select: { status: true, buyerId: true, sellerId: true } },
      },
    }),
  );
  if (!conversation) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }
  const { order } = conversation;
  const isParty =
    order.buyerId === actor.id ||
    order.sellerId === actor.id ||
    actor.role === "ADMIN";
  if (!isParty) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }
  return conversation;
}

async function requireConversationId(
  actor: RlsActor,
  ref: string,
): Promise<string> {
  const conversationId = await withRlsTransaction({ actor }, (tx) =>
    findConversationIdByRef(tx, ref),
  );
  if (!conversationId) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }
  await assertConversationParty(actor, conversationId);
  return conversationId;
}

conversationsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const conversations = await withRlsTransaction({ actor }, (tx) =>
      tx.conversation.findMany({
        where: {
          order: {
            OR: [{ buyerId: actor.id }, { sellerId: actor.id }],
          },
        },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 50,
        select: {
          ...conversationSelect,
          messages: {
            where: { internal: false },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              body: true,
              senderId: true,
              createdAt: true,
              sender: { select: { id: true, name: true } },
            },
          },
        },
      }),
    );

    const ids = conversations.map((c) => c.id);
    const unreadRows =
      ids.length === 0
        ? []
        : await withRlsTransaction({ actor }, (tx) =>
            tx.message.groupBy({
              by: ["conversationId"],
              where: {
                conversationId: { in: ids },
                readAt: null,
                senderId: { not: actor.id },
              },
              _count: { _all: true },
            }),
          );

    const unreadMap = new Map(
      unreadRows.map((row) => [row.conversationId, row._count._all]),
    );

    res.json({
      conversations: conversations.map((c) => ({
        ...c,
        ...serializeConversationTimestamps(c),
        unreadCount: unreadMap.get(c.id) ?? 0,
      })),
    });
  }),
);

conversationsRouter.get(
  "/by-order/:orderId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.orderId, "orderId");
    const conversation = await withRlsTransaction({ actor }, async (tx) => {
      const orderId = await findOrderIdByRef(tx, ref);
      if (!orderId) return null;
      return tx.conversation.findUnique({
        where: { orderId },
        select: conversationSelect,
      });
    });
    if (!conversation) {
      throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
    }
    const isParty =
      conversation.order.buyerId === actor.id ||
      conversation.order.sellerId === actor.id ||
      actor.role === "ADMIN";
    if (!isParty) {
      throw new AppError(403, "Forbidden", "FORBIDDEN");
    }
    res.json({
      conversation: {
        ...conversation,
        ...serializeConversationTimestamps(conversation),
      },
    });
  }),
);

conversationsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const conversationId = await requireConversationId(actor, ref);
    const conversation = await withRlsTransaction({ actor }, (tx) =>
      tx.conversation.findUnique({
        where: { id: conversationId },
        select: conversationSelect,
      }),
    );
    res.json({
      conversation: conversation
        ? {
            ...conversation,
            ...serializeConversationTimestamps(conversation),
            partiesOnline: {
              buyer: isUserOnline(conversation.order.buyerId),
              seller: isUserOnline(conversation.order.sellerId),
            },
          }
        : null,
    });
  }),
);

conversationsRouter.get(
  "/:id/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const conversationId = await requireConversationId(actor, ref);

    const after =
      typeof req.query.after === "string" && req.query.after.length > 0
        ? req.query.after
        : undefined;
    const take = Math.min(Number(req.query.limit) || 80, 120);

    const messages = await withRlsTransaction({ actor }, (tx) =>
      tx.message.findMany({
        where: {
          conversationId,
          // Notas internas da moderação nunca vão para o app do usuário.
          ...(actor.role === "ADMIN" ? {} : { internal: false }),
          ...(after ? { createdAt: { gt: new Date(after) } } : {}),
        },
        orderBy: { createdAt: "asc" },
        take,
        select: messageSelect,
      }),
    );

    res.json({
      messages,
      nextCursor:
        messages.length === take
          ? (messages[messages.length - 1]?.id ?? null)
          : null,
    });
  }),
);

conversationsRouter.post(
  "/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const conversationId = await requireConversationId(actor, ref);
    const result = await markConversationRead({
      conversationId,
      actor,
    });
    res.json(result);
  }),
);

conversationsRouter.post(
  "/:id/messages",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const ref = routeParam(req.params.id);
    const conversationId = await requireConversationId(actor, ref);
    const parsed = sendSchema.parse(req.body);

    const { message, created } = await sendConversationMessage({
      conversationId,
      body: parsed.body,
      clientId: parsed.clientId,
      actor,
    });

    res.status(created ? 201 : 200).json({ message });
  }),
);
