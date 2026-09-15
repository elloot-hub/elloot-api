import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { withServiceTransaction } from "../databases";
import { AppError } from "../lib/errors";
import { authenticateAccessToken } from "../middleware/auth";
import { authenticateAdminAccessToken } from "../middleware/admin-auth";
import { sendConversationMessage } from "../modules/conversations/conversations.service";
import {
  addPresenceSocket,
  isUserOnline,
  removePresenceSocket,
} from "./presence";
import { filterAllowedPresenceIds } from "./presence-authz";
import {
  parseCookieValue,
  shouldPreferAdminCookie,
  adminCorsOrigins,
  appCorsOrigins,
} from "./socket-auth";
import {
  consumeSocketRateLimit,
  pruneSocketRateLimits,
} from "./socket-rate-limit";
import { findConversationIdByRef } from "../modules/conversations/conversation-ref";
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "./types";

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

let io: RealtimeServer | null = null;

export function getIO(): RealtimeServer | null {
  return io;
}

export function userRoom(userId: string) {
  return `user:${userId}`;
}

export function conversationRoom(conversationId: string) {
  return `conversation:${conversationId}`;
}

export function presenceRoom(userId: string) {
  return `presence:${userId}`;
}

export function adminChatsRoom() {
  return "admin:chats";
}

const MAX_PRESENCE_SUBSCRIBE = 20;

export function attachRealtime(httpServer: HttpServer): RealtimeServer {
  const origins = [...appCorsOrigins(), ...adminCorsOrigins()].filter(Boolean);

  io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: "/socket.io",
    cors: {
      origin: origins,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    void (async () => {
      try {
        const fromAuth =
          typeof socket.handshake.auth?.token === "string"
            ? socket.handshake.auth.token
            : null;
        const fromHeader =
          typeof socket.handshake.headers.authorization === "string" &&
          socket.handshake.headers.authorization.startsWith("Bearer ")
            ? socket.handshake.headers.authorization.slice("Bearer ".length)
            : null;

        const cookieHeader = socket.handshake.headers.cookie;
        const fromAdminCookie = parseCookieValue(
          typeof cookieHeader === "string" ? cookieHeader : undefined,
          "elloot_admin_at",
        );
        const fromUserCookie = parseCookieValue(
          typeof cookieHeader === "string" ? cookieHeader : undefined,
          "elloot_at",
        );

        const originHeader = socket.handshake.headers.origin;
        const refererHeader = socket.handshake.headers.referer;
        let origin =
          typeof originHeader === "string" ? originHeader : undefined;
        if (!origin && typeof refererHeader === "string") {
          try {
            origin = new URL(refererHeader).origin;
          } catch {
            /* ignore */
          }
        }
        const authPanel =
          typeof socket.handshake.auth?.panel === "string"
            ? socket.handshake.auth.panel
            : null;

        const preferAdmin = shouldPreferAdminCookie({
          origin,
          hasAdminCookie: Boolean(fromAdminCookie),
          hasUserCookie: Boolean(fromUserCookie),
          authPanel,
        });

        if (preferAdmin && fromAdminCookie) {
          try {
            const { user } =
              await authenticateAdminAccessToken(fromAdminCookie);
            socket.data.user = {
              id: user.id,
              email: user.email,
              role: "ADMIN",
            };
            socket.data.fromAdminPanel = true;
            next();
            return;
          } catch {
            // Admin cookie inválido — tenta sessão do marketplace.
          }
        }

        const raw = fromUserCookie || fromAuth || fromHeader;
        if (!raw) {
          // Último recurso: cookie admin sem Origin de app (tooling).
          if (fromAdminCookie) {
            try {
              const { user } =
                await authenticateAdminAccessToken(fromAdminCookie);
              socket.data.user = {
                id: user.id,
                email: user.email,
                role: "ADMIN",
              };
              socket.data.fromAdminPanel = true;
              next();
              return;
            } catch {
              /* fallthrough */
            }
          }
          next(new Error("UNAUTHORIZED"));
          return;
        }

        const { user } = await authenticateAccessToken(raw);
        socket.data.user = user;
        socket.data.fromAdminPanel = false;
        next();
      } catch {
        next(new Error("UNAUTHORIZED"));
      }
    })();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    void socket.join(userRoom(user.id));
    if (socket.data.fromAdminPanel) {
      void socket.join(adminChatsRoom());
    }

    const becameOnline = addPresenceSocket(user.id, socket.id);
    void touchLastSeen(user.id).then((lastSeenAt) => {
      if (becameOnline) {
        io?.to(presenceRoom(user.id)).emit("presence:update", {
          userId: user.id,
          online: true,
          lastSeenAt,
        });
      }
    });

    socket.on("presence:subscribe", (payload) => {
      const requested = Array.isArray(payload?.userIds)
        ? payload.userIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      void (async () => {
        const isAdminViewer =
          Boolean(socket.data.fromAdminPanel) || user.role === "ADMIN";
        const ids = isAdminViewer
          ? [...new Set(requested)].slice(0, MAX_PRESENCE_SUBSCRIBE)
          : await filterAllowedPresenceIds(user.id, requested);

        for (const id of ids) {
          void socket.join(presenceRoom(id));
          socket.emit("presence:update", {
            userId: id,
            online: isUserOnline(id),
            lastSeenAt: null,
          });
        }
        if (ids.length === 0) return;

        const users = await withServiceTransaction(async (tx) =>
          tx.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, lastSeenAt: true },
          }),
        );
        for (const u of users) {
          socket.emit("presence:update", {
            userId: u.id,
            online: isUserOnline(u.id),
            lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
          });
        }
      })().catch(() => undefined);
    });

    socket.on("presence:unsubscribe", (payload) => {
      const ids = Array.isArray(payload?.userIds)
        ? payload.userIds.filter((id) => typeof id === "string")
        : [];
      for (const id of ids) {
        void socket.leave(presenceRoom(id));
      }
    });

    socket.on("conversation:join", async (payload, ack) => {
      try {
        const conversationRef = payload?.conversationId;
        if (!conversationRef) {
          ack?.({ ok: false, error: "INVALID_PAYLOAD" });
          return;
        }
        const resolvedId = await withServiceTransaction(async (tx) =>
          findConversationIdByRef(tx, conversationRef),
        );
        if (!resolvedId) {
          ack?.({ ok: false, error: "CONVERSATION_NOT_FOUND" });
          return;
        }
        const parties = await assertCanJoinConversation(
          user.id,
          user.role,
          resolvedId,
        );
        await socket.join(conversationRoom(resolvedId));

        // Admin no thread: já entra nas rooms de presence das partes
        // (inbox/UI funcionam mesmo se presence:subscribe atrasar).
        if (socket.data.fromAdminPanel || user.role === "ADMIN") {
          for (const partyId of [parties.buyerId, parties.sellerId]) {
            void socket.join(presenceRoom(partyId));
            socket.emit("presence:update", {
              userId: partyId,
              online: isUserOnline(partyId),
              lastSeenAt: null,
            });
          }
        }

        ack?.({ ok: true });
      } catch (err) {
        ack?.({
          ok: false,
          error: err instanceof AppError ? err.code : "FORBIDDEN",
        });
      }
    });

    socket.on("conversation:leave", (payload) => {
      if (!payload?.conversationId) return;
      void (async () => {
        const resolvedId = await withServiceTransaction(async (tx) =>
          findConversationIdByRef(tx, payload.conversationId),
        );
        void socket.leave(
          conversationRoom(resolvedId ?? payload.conversationId),
        );
      })().catch(() => {
        void socket.leave(conversationRoom(payload.conversationId));
      });
    });

    socket.on("message:send", async (payload, ack) => {
      try {
        const allowed = consumeSocketRateLimit({
          key: `msg:${user.id}`,
          max: 30,
          windowMs: 60_000,
        });
        if (!allowed) {
          ack?.({ ok: false, error: "RATE_LIMITED" });
          return;
        }
        if (Math.random() < 0.01) pruneSocketRateLimits();

        const conversationId = payload?.conversationId;
        const body = payload?.body;
        if (!conversationId || typeof body !== "string") {
          ack?.({ ok: false, error: "INVALID_PAYLOAD" });
          return;
        }
        const { message } = await sendConversationMessage({
          conversationId,
          body,
          clientId: payload.clientId,
          actor: user,
        });
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({
          ok: false,
          error: err instanceof AppError ? err.code : "SEND_FAILED",
        });
      }
    });

    socket.on("disconnect", () => {
      const wentOffline = removePresenceSocket(user.id, socket.id);
      if (!wentOffline) return;
      void touchLastSeen(user.id).then((lastSeenAt) => {
        io?.to(presenceRoom(user.id)).emit("presence:update", {
          userId: user.id,
          online: false,
          lastSeenAt,
        });
      });
    });
  });

  return io;
}

async function touchLastSeen(userId: string): Promise<string | null> {
  try {
    const user = await withServiceTransaction(async (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
        select: { lastSeenAt: true },
      }),
    );
    return user.lastSeenAt?.toISOString() ?? null;
  } catch {
    return new Date().toISOString();
  }
}

async function assertCanJoinConversation(
  userId: string,
  role: string,
  conversationRef: string,
): Promise<{ buyerId: string; sellerId: string }> {
  const conversation = await withServiceTransaction(async (tx) => {
    const id = await findConversationIdByRef(tx, conversationRef);
    if (!id) return null;
    return tx.conversation.findUnique({
      where: { id },
      select: {
        order: { select: { buyerId: true, sellerId: true } },
      },
    });
  });
  if (!conversation) {
    throw new AppError(404, "Conversation not found", "CONVERSATION_NOT_FOUND");
  }
  const { buyerId, sellerId } = conversation.order;
  if (buyerId !== userId && sellerId !== userId && role !== "ADMIN") {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }
  return { buyerId, sellerId };
}
