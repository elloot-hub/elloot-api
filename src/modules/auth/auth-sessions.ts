import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { jwtExpiresMs } from "../../lib/auth-cookie";
import { revokeAccessToken } from "./token-revoke";

type Tx = Prisma.TransactionClient;

export function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim().slice(0, 64) || null;
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim().slice(0, 64);
  }
  const addr = req.socket.remoteAddress;
  return addr ? addr.replace(/^::ffff:/, "").slice(0, 64) : null;
}

export function readUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  if (typeof ua !== "string" || !ua.trim()) return null;
  return ua.trim().slice(0, 400);
}

export function parseUserAgent(ua: string | null | undefined): {
  browser: string;
  os: string;
} {
  const value = ua ?? "";
  let browser = "Navegador";
  if (/Edg\//i.test(value)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(value)) browser = "Opera";
  else if (/Chrome\//i.test(value) && !/Chromium/i.test(value)) browser = "Chrome";
  else if (/Firefox\//i.test(value)) browser = "Firefox";
  else if (/Safari\//i.test(value) && !/Chrome\//i.test(value)) browser = "Safari";
  else if (/SamsungBrowser/i.test(value)) browser = "Samsung Internet";

  let os = "Dispositivo";
  if (/Windows NT 10/i.test(value)) os = "Windows 10";
  else if (/Windows NT 11|Windows NT 10\.0.*Windows 11/i.test(value)) os = "Windows 11";
  else if (/Windows NT 6\.3/i.test(value)) os = "Windows 8.1";
  else if (/Windows NT 6\.1/i.test(value)) os = "Windows 7";
  else if (/Windows/i.test(value)) os = "Windows";
  else if (/Android/i.test(value)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(value)) os = "iOS";
  else if (/Mac OS X/i.test(value)) os = "macOS";
  else if (/Linux/i.test(value)) os = "Linux";
  else if (/CrOS/i.test(value)) os = "ChromeOS";

  return { browser, os };
}

export async function createAuthSession(
  tx: Tx,
  input: {
    userId: string;
    tokenJti: string;
    userAgent?: string | null;
    ip?: string | null;
  },
) {
  return tx.authSession.create({
    data: {
      userId: input.userId,
      tokenJti: input.tokenJti,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      lastSeenAt: new Date(),
    },
  });
}

export async function touchAuthSessionByJti(tx: Tx, tokenJti: string) {
  await tx.authSession.updateMany({
    where: { tokenJti, revokedAt: null },
    data: { lastSeenAt: new Date() },
  });
}

export async function ensureAuthSession(
  tx: Tx,
  input: {
    userId: string;
    tokenJti: string;
    userAgent?: string | null;
    ip?: string | null;
  },
) {
  const existing = await tx.authSession.findUnique({
    where: { tokenJti: input.tokenJti },
  });
  if (existing) {
    if (existing.revokedAt) return existing;
    return tx.authSession.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        userAgent: input.userAgent ?? existing.userAgent,
        ip: input.ip ?? existing.ip,
      },
    });
  }
  return createAuthSession(tx, input);
}

export async function revokeAuthSessionByJti(
  tx: Tx,
  tokenJti: string,
  opts?: { expiresAtMs?: number },
) {
  await tx.authSession.updateMany({
    where: { tokenJti, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await revokeAccessToken(tokenJti, {
    jti: tokenJti,
    expiresAtMs: opts?.expiresAtMs ?? Date.now() + jwtExpiresMs(),
  });
}

export async function revokeAuthSessionById(
  tx: Tx,
  input: { userId: string; sessionId: string },
) {
  const session = await tx.authSession.findFirst({
    where: {
      id: input.sessionId,
      userId: input.userId,
      revokedAt: null,
    },
  });
  if (!session) return null;

  await tx.authSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });
  await revokeAccessToken(session.tokenJti, {
    jti: session.tokenJti,
    expiresAtMs: Date.now() + jwtExpiresMs(),
  });
  return session;
}

/** Revoke every active session for a user and blacklist JTIs (reset / reclaim). */
export async function revokeAllUserSessions(tx: Tx, userId: string) {
  const sessions = await tx.authSession.findMany({
    where: { userId, revokedAt: null },
    select: { tokenJti: true },
  });
  if (sessions.length === 0) return 0;

  await tx.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const expiresAtMs = Date.now() + jwtExpiresMs();
  await Promise.all(
    sessions.map((s) =>
      revokeAccessToken(s.tokenJti, {
        jti: s.tokenJti,
        expiresAtMs,
      }),
    ),
  );
  return sessions.length;
}
