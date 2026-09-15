import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, type RlsActor } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { routeParam } from "../../lib/route-param";
import { sendConversationMessage } from "../conversations/conversations.service";
import { findConversationIdByRef } from "../conversations/conversation-ref";
import { openDispute } from "../disputes/disputes.service";
import { sanitizeUserText } from "../../lib/sanitize";
import { isUserOnline } from "../../realtime/presence";
import { emitConversationRead } from "../../realtime/emit";

export const adminChatsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: "ADMIN" };
}

async function resolveConversationId(
  actor: RlsActor,
  ref: string,
): Promise<string> {
  const id = await withRlsTransaction({ actor }, (tx) =>
    findConversationIdByRef(tx, ref),
  );
  if (!id) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
  }
  return id;
}

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "REPORTED", "RESOLVED", "ALL"]).optional().default("ALL"),
  q: z.string().trim().max(120).optional(),
  take: z.coerce.number().int().min(1).max(100).optional().default(40),
});

const bodySchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

const patchSchema = z.object({
  status: z.enum(["RESOLVED"]),
});

type Party = { id: string; name: string | null; email: string; avatarUrl: string | null };

function partyName(p: { name: string | null; email: string }) {
  return p.name?.trim() || p.email;
}

function displayName(p: { name: string | null; email?: string | null } | null | undefined) {
  if (!p) return null;
  const name = p.name?.trim();
  if (name) return name;
  const email = p.email?.trim();
  if (email) return email.split("@")[0] ?? email;
  return null;
}

function previewOf(body: string) {
  const stripped = stripReplyMarker(body).trim();
  if (!stripped) return "Sem mensagens";
  return stripped.length > 120
    ? `${stripped.slice(0, 117).trimEnd()}…`
    : stripped;
}

function stripReplyMarker(body: string) {
  if (!body.startsWith("[[elloot-reply:")) return body;
  const close = body.indexOf("]]");
  if (close < 0) return body;
  return body.slice(close + 2).replace(/^\n/, "").trimStart();
}

function authorOf(
  senderId: string,
  buyerId: string,
  sellerId: string,
): "BUYER" | "SELLER" | "ADMIN" {
  if (senderId === buyerId) return "BUYER";
  if (senderId === sellerId) return "SELLER";
  return "ADMIN";
}

function waitingHours(from: Date | null | undefined) {
  if (!from) return 0;
  return Math.max(0, (Date.now() - from.getTime()) / 3_600_000);
}

function isUnread(row: {
  adminLastReadAt: Date | null;
  lastMessageAt: Date | null;
}) {
  if (!row.lastMessageAt) return false;
  if (!row.adminLastReadAt) return true;
  return row.lastMessageAt.getTime() > row.adminLastReadAt.getTime();
}

function serializeConversation(row: {
  id: string;
  moderationStatus: "OPEN" | "REPORTED" | "RESOLVED";
  reportReason: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  adminLastReadAt: Date | null;
  buyerLastReadAt: Date | null;
  sellerLastReadAt: Date | null;
  createdAt: Date;
  order: {
    id: string;
    code: string;
    status: string;
    amountCents: number;
    paidAt: Date | null;
    deliveredAt: Date | null;
    deliveryContent: string | null;
    buyerId: string;
    sellerId: string;
    listing: {
      id: string;
      title: string;
      deliveryMode: string;
      media: Array<{ url: string }>;
    };
    offer: { title: string; deliveryMode: string } | null;
    dispute: {
      id: string;
      code: string;
      reason: string;
      status: string;
    } | null;
    escrowHold: {
      amountCents: number;
      releaseAt: Date | null;
      releasedAt: Date | null;
    } | null;
    buyer: Party;
    seller: Party;
  };
  messages?: Array<{
    body: string;
    senderId: string;
    createdAt: Date;
    internal: boolean;
  }>;
}) {
  const lastVisible =
    row.messages?.find((m) => !m.internal) ??
    null;

  // Nunca usar `new Date()` aqui — isso fazia a lista mostrar "agora"
  // em conversas sem lastMessageAt (preview "—").
  const lastAt = lastVisible?.createdAt ?? row.lastMessageAt;
  const activityAt = lastAt ?? row.createdAt;
  const lastBody = lastVisible?.body ?? row.lastMessagePreview ?? "";
  const lastAuthor = lastVisible
    ? authorOf(lastVisible.senderId, row.order.buyerId, row.order.sellerId)
    : "BUYER";

  const coverUrl = row.order.listing.media[0]?.url ?? null;
  const hold = row.order.escrowHold;

  return {
    id: row.id,
    status: row.moderationStatus,
    buyer: {
      id: row.order.buyer.id,
      name: partyName(row.order.buyer),
      avatarUrl: row.order.buyer.avatarUrl,
    },
    seller: {
      id: row.order.seller.id,
      name: partyName(row.order.seller),
      avatarUrl: row.order.seller.avatarUrl,
    },
    listing: {
      id: row.order.listing.id,
      title: row.order.listing.title,
      coverUrl,
      deliveryMode: row.order.listing.deliveryMode,
    },
    orderId: row.order.id,
    order: {
      id: row.order.id,
      code: row.order.code,
      status: row.order.status,
      amountCents: row.order.amountCents,
      paidAt: row.order.paidAt?.toISOString() ?? null,
      deliveredAt: row.order.deliveredAt?.toISOString() ?? null,
      deliveryContent: row.order.deliveryContent ?? null,
      offerTitle: row.order.offer?.title ?? null,
      offerDeliveryMode: row.order.offer?.deliveryMode ?? null,
      disputeId: row.order.dispute?.id ?? null,
      disputeCode: row.order.dispute?.code ?? null,
      disputeReason: row.order.dispute?.reason ?? null,
      disputeStatus: row.order.dispute?.status ?? null,
      protectionHold: hold
        ? {
            amountCents: hold.amountCents,
            releaseAt: hold.releaseAt?.toISOString() ?? null,
            releasedAt: hold.releasedAt?.toISOString() ?? null,
          }
        : null,
    },
    lastMessage: (() => {
      const hasPublicMessage = Boolean(
        lastVisible?.body?.trim() ||
          (row.lastMessageAt && lastBody.trim()),
      );
      return {
        preview: hasPublicMessage
          ? previewOf(lastBody)
          : "Aguardando primeira mensagem",
        author: hasPublicMessage ? lastAuthor : null,
        sentAt: activityAt.toISOString(),
        empty: !hasPublicMessage,
      };
    })(),
    unread: isUnread(row),
    reportReason: row.reportReason,
    // Espera só conta a partir da última mensagem pública — sem msg, 0.
    waitingHours: waitingHours(lastAt),
    buyerLastReadAt: row.buyerLastReadAt?.toISOString() ?? null,
    sellerLastReadAt: row.sellerLastReadAt?.toISOString() ?? null,
  };
}

const conversationSelect = {
  id: true,
  moderationStatus: true,
  reportReason: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  adminLastReadAt: true,
  buyerLastReadAt: true,
  sellerLastReadAt: true,
  resolvedAt: true,
  createdAt: true,
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      amountCents: true,
      paidAt: true,
      deliveredAt: true,
      deliveryContent: true,
      buyerId: true,
      sellerId: true,
      listing: {
        select: {
          id: true,
          title: true,
          deliveryMode: true,
          media: {
            take: 1,
            orderBy: { sortOrder: "asc" as const },
            select: { url: true },
          },
        },
      },
      offer: { select: { title: true, deliveryMode: true } },
      dispute: { select: { id: true, code: true, reason: true, status: true } },
      escrowHold: {
        select: { amountCents: true, releaseAt: true, releasedAt: true },
      },
      buyer: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
      seller: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  },
  messages: {
    where: { internal: false },
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      body: true,
      senderId: true,
      createdAt: true,
      internal: true,
    },
  },
} as const;

adminChatsRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const startOfToday = new Date();
    // America/Sao_Paulo ≈ UTC-3 (bom o bastante para o painel)
    startOfToday.setUTCHours(3, 0, 0, 0);
    if (Date.now() < startOfToday.getTime()) {
      startOfToday.setUTCDate(startOfToday.getUTCDate() - 1);
    }
    const waitingCutoff = new Date(Date.now() - 24 * 3_600_000);

    const stats = await withRlsTransaction({ actor }, async (tx) => {
      const [open, reported, waitingOver24h, resolvedToday] = await Promise.all([
        tx.conversation.count({ where: { moderationStatus: "OPEN" } }),
        tx.conversation.count({ where: { moderationStatus: "REPORTED" } }),
        tx.conversation.count({
          where: {
            moderationStatus: { not: "RESOLVED" },
            lastMessageAt: { lte: waitingCutoff },
          },
        }),
        tx.conversation.count({
          where: {
            moderationStatus: "RESOLVED",
            resolvedAt: { gte: startOfToday },
          },
        }),
      ]);
      return { open, reported, waitingOver24h, resolvedToday };
    });

    res.json({ stats });
  }),
);

adminChatsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = listQuerySchema.parse(req.query);
    const q = query.q?.trim();

    const items = await withRlsTransaction({ actor }, async (tx) => {
      const rows = await tx.conversation.findMany({
        where: {
          ...(query.status !== "ALL"
            ? { moderationStatus: query.status }
            : {}),
          ...(q
            ? {
                OR: [
                  {
                    order: {
                      listing: {
                        title: { contains: q, mode: "insensitive" },
                      },
                    },
                  },
                  {
                    order: {
                      buyer: {
                        OR: [
                          { name: { contains: q, mode: "insensitive" } },
                          { email: { contains: q, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                  {
                    order: {
                      seller: {
                        OR: [
                          { name: { contains: q, mode: "insensitive" } },
                          { email: { contains: q, mode: "insensitive" } },
                        ],
                      },
                    },
                  },
                  {
                    order: {
                      code: { contains: q, mode: "insensitive" },
                    },
                  },
                  {
                    lastMessagePreview: {
                      contains: q,
                      mode: "insensitive",
                    },
                  },
                ],
              }
            : {}),
        },
        orderBy: [
          { lastMessageAt: "desc" },
          { createdAt: "desc" },
        ],
        take: query.take,
        select: conversationSelect,
      });
      return rows.map(serializeConversation);
    });

    res.json({ items });
  }),
);

adminChatsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = await resolveConversationId(actor, routeParam(req.params.id));

    const thread = await withRlsTransaction({ actor }, async (tx) => {
      const row = await tx.conversation.findUnique({
        where: { id },
        select: {
          ...conversationSelect,
          messages: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              body: true,
              senderId: true,
              internal: true,
              createdAt: true,
              sender: {
                select: { id: true, name: true, email: true },
              },
            },
          },
        },
      });
      if (!row) {
        throw new AppError(404, "Conversation not found", "NOT_FOUND");
      }

      const adminReadAt = new Date();
      await tx.conversation.update({
        where: { id },
        data: { adminLastReadAt: adminReadAt },
      });

      const conversation = serializeConversation({
        ...row,
        adminLastReadAt: adminReadAt,
        messages: row.messages
          .filter((m) => !m.internal)
          .slice()
          .reverse()
          .slice(0, 1),
      });

      const messages = row.messages.map((m) => {
        const author = authorOf(
          m.senderId,
          row.order.buyerId,
          row.order.sellerId,
        );
        const sentAt = m.createdAt.toISOString();
        const sentMs = m.createdAt.getTime();
        const buyerRead =
          !m.internal &&
          author === "ADMIN" &&
          row.buyerLastReadAt != null &&
          sentMs <= row.buyerLastReadAt.getTime();
        const sellerRead =
          !m.internal &&
          author === "ADMIN" &&
          row.sellerLastReadAt != null &&
          sentMs <= row.sellerLastReadAt.getTime();

        return {
          id: m.id,
          author,
          authorName:
            author === "ADMIN"
              ? displayName(m.sender) ?? "Equipe"
              : displayName(m.sender),
          internal: m.internal,
          body: m.body,
          sentAt,
          readByBuyer: author === "ADMIN" && !m.internal ? buyerRead : undefined,
          readBySeller:
            author === "ADMIN" && !m.internal ? sellerRead : undefined,
        };
      });

      return {
        conversation,
        messages,
        partiesOnline: {
          buyer: isUserOnline(row.order.buyerId),
          seller: isUserOnline(row.order.sellerId),
        },
        _emitAdminRead: {
          buyerLastReadAt: row.buyerLastReadAt?.toISOString() ?? null,
          sellerLastReadAt: row.sellerLastReadAt?.toISOString() ?? null,
          adminLastReadAt: adminReadAt.toISOString(),
        },
      };
    });

    emitConversationRead({
      conversationId: id,
      readerId: actor.id,
      role: "ADMIN",
      buyerLastReadAt: thread._emitAdminRead.buyerLastReadAt,
      sellerLastReadAt: thread._emitAdminRead.sellerLastReadAt,
      adminLastReadAt: thread._emitAdminRead.adminLastReadAt,
    });

    const { _emitAdminRead: _, ...payload } = thread;
    res.json(payload);
  }),
);

adminChatsRouter.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = await resolveConversationId(actor, routeParam(req.params.id));
    const { body } = bodySchema.parse(req.body);

    const { message } = await sendConversationMessage({
      conversationId: id,
      body,
      actor,
      internal: false,
    });

    await withRlsTransaction({ actor }, (tx) =>
      tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "chat.admin_reply",
          entityType: "Conversation",
          entityId: id,
          meta: { messageId: message.id },
        },
      }),
    );

    res.status(201).json({
      id: message.id,
      author: "ADMIN" as const,
      authorName: displayName(message.sender) ?? "Equipe",
      internal: false,
      body: message.body,
      sentAt:
        typeof message.createdAt === "string"
          ? message.createdAt
          : message.createdAt.toISOString(),
      readByBuyer: false,
      readBySeller: false,
    });
  }),
);

adminChatsRouter.post(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = await resolveConversationId(actor, routeParam(req.params.id));
    const { body } = bodySchema.parse(req.body);

    const { message } = await sendConversationMessage({
      conversationId: id,
      body,
      actor,
      internal: true,
    });

    await withRlsTransaction({ actor }, (tx) =>
      tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "chat.internal_note",
          entityType: "Conversation",
          entityId: id,
          meta: { messageId: message.id },
        },
      }),
    );

    res.status(201).json({
      id: message.id,
      author: "ADMIN" as const,
      authorName: displayName(message.sender) ?? "Equipe",
      internal: true,
      body: message.body,
      sentAt:
        typeof message.createdAt === "string"
          ? message.createdAt
          : message.createdAt.toISOString(),
    });
  }),
);

adminChatsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = await resolveConversationId(actor, routeParam(req.params.id));
    patchSchema.parse(req.body);

    const conversation = await withRlsTransaction({ actor }, async (tx) => {
      const existing = await tx.conversation.findUnique({
        where: { id },
        select: conversationSelect,
      });
      if (!existing) {
        throw new AppError(404, "Conversation not found", "NOT_FOUND");
      }

      const updated = await tx.conversation.update({
        where: { id },
        data: {
          moderationStatus: "RESOLVED",
          resolvedAt: existing.resolvedAt ?? new Date(),
        },
        select: conversationSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "chat.resolved",
          entityType: "Conversation",
          entityId: id,
        },
      });

      return serializeConversation(updated);
    });

    res.json({ conversation });
  }),
);

adminChatsRouter.post(
  "/:id/escalate",
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const id = await resolveConversationId(actor, routeParam(req.params.id));

    const chat = await withRlsTransaction({ actor }, (tx) =>
      tx.conversation.findUnique({
        where: { id },
        select: {
          id: true,
          orderId: true,
          order: {
            select: {
              id: true,
              code: true,
              buyerId: true,
              sellerId: true,
            },
          },
        },
      }),
    );
    if (!chat) {
      throw new AppError(404, "Conversation not found", "NOT_FOUND");
    }

    const reason = sanitizeUserText(
      "Escalado pela moderação a partir do chat.",
      2000,
    );

    const dispute = await openDispute({
      orderId: chat.orderId,
      reason,
      actor,
    });

    const conversation = await withRlsTransaction({ actor }, async (tx) => {
      const updated = await tx.conversation.update({
        where: { id },
        data: {
          moderationStatus: "REPORTED",
          reportReason: reason,
          resolvedAt: null,
        },
        select: conversationSelect,
      });

      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "chat.escalated",
          entityType: "Conversation",
          entityId: id,
          meta: { disputeId: dispute.id, orderId: chat.orderId },
        },
      });

      return serializeConversation(updated);
    });

    res.json({ disputeId: dispute.id, conversation });
  }),
);
