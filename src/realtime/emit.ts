import { getIO, conversationRoom, userRoom, adminChatsRoom } from "./io";
import type {
  PresenceUpdatePayload,
  RealtimeConversationReadPayload,
  RealtimeMessagePayload,
  RealtimeNotificationPayload,
} from "./types";

export function emitMessageNew(
  payload: RealtimeMessagePayload,
  opts?: { notifyUserIds?: string[]; adminOnly?: boolean },
) {
  const io = getIO();
  if (!io) return;

  // Painel admin (inbox + qualquer thread aberta via room global).
  io.to(adminChatsRoom()).emit("message:new", payload);

  // Quem entrou na room da conversa (admin no thread) também recebe —
  // cobre o caso do socket admin não ter entrado em admin:chats.
  if (!opts?.adminOnly && !payload.message.internal) {
    io.to(conversationRoom(payload.conversationId)).emit(
      "message:new",
      payload,
    );
  }

  if (opts?.adminOnly || payload.message.internal) {
    return;
  }

  // Inbox do app: rooms por usuário (mesmo fora da conversa).
  // Clientes deduplicam por message.id se também estiverem na conversation room.
  const userIds = opts?.notifyUserIds?.filter(Boolean) ?? [];
  for (const userId of userIds) {
    io.to(userRoom(userId)).emit("message:new", payload);
  }
}

export function emitConversationRead(payload: RealtimeConversationReadPayload) {
  const io = getIO();
  if (!io) return;
  io.to(adminChatsRoom()).emit("conversation:read", payload);
  io.to(conversationRoom(payload.conversationId)).emit(
    "conversation:read",
    payload,
  );
}

export function emitNotificationNew(
  userId: string,
  payload: RealtimeNotificationPayload,
) {
  getIO()?.to(userRoom(userId)).emit("notification:new", payload);
}

export function emitPresenceUpdate(payload: PresenceUpdatePayload) {
  getIO()?.to(`presence:${payload.userId}`).emit("presence:update", payload);
}
