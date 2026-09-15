import {
  withRlsTransaction,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { AppError } from "../../lib/errors";
import { sanitizeUserText } from "../../lib/sanitize";
import { routes } from "./hrefs";
import { emitConversationRead, emitMessageNew } from "../../realtime/emit";
import { notifyUser } from "./notifications.notify";
import { findConversationIdByRef } from "./conversation-ref";

export const messageSelect = {
  id: true,
  conversationId: true,
  body: true,
  senderId: true,
  clientId: true,
  readAt: true,
  internal: true,
  createdAt: true,
  sender: { select: { id: true, name: true, avatarUrl: true } },
} as const;

function stripReplyMarker(body: string) {
  if (!body.startsWith("[[elloot-reply:")) return body;
  const close = body.indexOf("]]");
  if (close < 0) return body;
  return body.slice(close + 2).replace(/^\n/, "").trimStart();
}

function serializeMessage(
  message: {
    id: string;
    conversationId: string;
    body: string;
    senderId: string;
    clientId: string | null;
    readAt: Date | null;
    internal?: boolean;
    createdAt: Date;
    sender?: { id: string; name: string | null; avatarUrl?: string | null };
  },
) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    body: message.body,
    senderId: message.senderId,
    clientId: message.clientId,
    readAt: message.readAt?.toISOString() ?? null,
    internal: message.internal ?? false,
    createdAt: message.createdAt.toISOString(),
    sender: message.sender,
  };
}

export async function sendConversationMessage(input: {
  conversationId: string;
  body: string;
  clientId?: string;
  /** Nota interna — só a equipe vê. */
  internal?: boolean;
  actor: RlsActor;
}) {
  const body = sanitizeUserText(input.body, 4000);
  if (!body) {
    throw new AppError(400, "Message body is required", "VALIDATION_ERROR");
  }

  const internal = Boolean(input.internal);
  if (internal && input.actor.role !== "ADMIN") {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  // Aceita cuid da conversa OU ref pública (código do pedido ORD-…).
  const conversationId = await withRlsTransaction({ actor: input.actor }, (tx) =>
    findConversationIdByRef(tx, input.conversationId),
  );
  if (!conversationId) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }

  const conversation = await withRlsTransaction({ actor: input.actor }, (tx) =>
    tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        order: {
          select: {
            status: true,
            code: true,
            buyerId: true,
            sellerId: true,
            listing: { select: { title: true } },
          },
        },
      },
    }),
  );

  if (!conversation) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }

  const { order } = conversation;
  const isParty =
    order.buyerId === input.actor.id ||
    order.sellerId === input.actor.id ||
    input.actor.role === "ADMIN";
  if (!isParty) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  // Keep chat open after delivery/completion so parties can still resolve issues.
  // Only terminal money outcomes close messaging.
  const closed = ["REFUNDED", "CANCELLED", "EXPIRED"].includes(order.status);
  if (closed && input.actor.role !== "ADMIN") {
    throw new AppError(409, "Conversation is closed", "CONVERSATION_CLOSED");
  }

  if (input.clientId) {
    const existing = await withRlsTransaction({ actor: input.actor }, (tx) =>
      tx.message.findFirst({
        where: {
          conversationId,
          clientId: input.clientId,
        },
        select: messageSelect,
      }),
    );
    if (existing) {
      return { message: serializeMessage(existing), created: false as const };
    }
  }

  const now = new Date();
  const displayBody = stripReplyMarker(body);
  const preview =
    displayBody.length > 140
      ? `${displayBody.slice(0, 137).trimEnd()}…`
      : displayBody;

  const created = await withServiceTransaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: input.actor.id,
        body,
        clientId: input.clientId ?? null,
        internal,
      },
      select: messageSelect,
    });

    // Notas internas não alteram o preview do inbox do usuário.
    if (!internal) {
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: now,
          lastMessagePreview: preview,
        },
      });
    }

    return message;
  }, input.actor);

  const message = serializeMessage(created);

  if (internal) {
    emitMessageNew(
      { conversationId, message },
      { adminOnly: true },
    );
  } else {
    const notifyUserIds = [order.buyerId, order.sellerId];

    emitMessageNew(
      { conversationId, message },
      { notifyUserIds },
    );

    const recipients =
      input.actor.role === "ADMIN"
        ? [order.buyerId, order.sellerId].filter((id) => id !== input.actor.id)
        : [
            order.buyerId === input.actor.id ? order.sellerId : order.buyerId,
          ].filter((id) => id !== input.actor.id);

    const senderName =
      input.actor.role === "ADMIN"
        ? "Moderação"
        : created.sender?.name?.trim() || "Alguém";

    for (const recipientId of recipients) {
      void notifyUser({
        userId: recipientId,
        type: "MESSAGE",
        title: "Nova mensagem",
        body: `${senderName}: ${preview}`,
        href: routes.conversation(order.code),
        meta: {
          conversationId,
          messageId: message.id,
          orderCode: order.code,
        },
      });
    }
  }

  return { message, created: true as const };
}

export async function markConversationRead(input: {
  conversationId: string;
  actor: RlsActor;
}) {
  const conversationId = await withRlsTransaction({ actor: input.actor }, (tx) =>
    findConversationIdByRef(tx, input.conversationId),
  );
  if (!conversationId) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }

  const conversation = await withRlsTransaction({ actor: input.actor }, (tx) =>
    tx.conversation.findUnique({
      where: { id: conversationId },
      include: {
        order: { select: { buyerId: true, sellerId: true } },
      },
    }),
  );

  if (!conversation) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }

  const { order } = conversation;
  const isParty =
    order.buyerId === input.actor.id ||
    order.sellerId === input.actor.id ||
    input.actor.role === "ADMIN";
  if (!isParty) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }

  const result = await withServiceTransaction(async (tx) => {
    const now = new Date();
    const isBuyer = order.buyerId === input.actor.id;
    const isSeller = order.sellerId === input.actor.id;

    let buyerLastReadAt = conversation.buyerLastReadAt;
    let sellerLastReadAt = conversation.sellerLastReadAt;
    const adminLastReadAt = conversation.adminLastReadAt;

    if (isBuyer) {
      const updated = await tx.conversation.update({
        where: { id: conversationId },
        data: { buyerLastReadAt: now },
        select: {
          buyerLastReadAt: true,
          sellerLastReadAt: true,
          adminLastReadAt: true,
        },
      });
      buyerLastReadAt = updated.buyerLastReadAt;
      sellerLastReadAt = updated.sellerLastReadAt;
    } else if (isSeller) {
      const updated = await tx.conversation.update({
        where: { id: conversationId },
        data: { sellerLastReadAt: now },
        select: {
          buyerLastReadAt: true,
          sellerLastReadAt: true,
          adminLastReadAt: true,
        },
      });
      buyerLastReadAt = updated.buyerLastReadAt;
      sellerLastReadAt = updated.sellerLastReadAt;
    }

    const marked = await tx.message.updateMany({
      where: {
        conversationId,
        senderId: { not: input.actor.id },
        readAt: null,
        internal: false,
      },
      data: { readAt: now },
    });

    return {
      marked: marked.count,
      role: (isBuyer
        ? "BUYER"
        : isSeller
          ? "SELLER"
          : "ADMIN") as "BUYER" | "SELLER" | "ADMIN",
      buyerLastReadAt,
      sellerLastReadAt,
      adminLastReadAt,
    };
  }, input.actor);

  if (result.role === "BUYER" || result.role === "SELLER") {
    emitConversationRead({
      conversationId,
      readerId: input.actor.id,
      role: result.role,
      buyerLastReadAt: result.buyerLastReadAt?.toISOString() ?? null,
      sellerLastReadAt: result.sellerLastReadAt?.toISOString() ?? null,
      adminLastReadAt: result.adminLastReadAt?.toISOString() ?? null,
    });
  }

  return { marked: result.marked };
}
