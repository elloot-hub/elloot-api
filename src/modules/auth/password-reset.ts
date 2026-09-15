import { createHash, randomBytes } from "node:crypto";
import { connectRedis, redis } from "../../databases";
import { env } from "../../config/env";
import { sendPasswordResetEmail } from "../../lib/mailer";

const TTL_SEC = 60 * 60; // 1 hour
const memoryTokens = new Map<string, { userId: string; exp: number }>();
const memoryByUser = new Map<string, string>();

function tokenKey(tokenHash: string) {
  return `elloot:pwdreset:${tokenHash}`;
}

function userKey(userId: string) {
  return `elloot:pwdreset:user:${userId}`;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function newPasswordResetToken() {
  return randomBytes(32).toString("hex");
}

function pruneMemory() {
  const now = Date.now();
  for (const [k, v] of memoryTokens) {
    if (v.exp < now) {
      memoryTokens.delete(k);
      const owned = memoryByUser.get(v.userId);
      if (owned === k) memoryByUser.delete(v.userId);
    }
  }
}

async function clearPreviousForUser(userId: string) {
  if (redis) {
    try {
      await connectRedis();
      const prev = await redis.get(userKey(userId));
      if (prev) {
        await redis.del(tokenKey(prev));
        await redis.del(userKey(userId));
      }
      return;
    } catch {
      // fall through
    }
  }
  pruneMemory();
  const prev = memoryByUser.get(userId);
  if (prev) {
    memoryTokens.delete(prev);
    memoryByUser.delete(userId);
  }
}

/** Store raw token → userId. Returns the raw token to put in the email link. */
export async function storePasswordResetToken(userId: string): Promise<string> {
  const raw = newPasswordResetToken();
  const tokenHash = hashToken(raw);
  await clearPreviousForUser(userId);

  if (redis) {
    try {
      await connectRedis();
      await redis.set(tokenKey(tokenHash), userId, "EX", TTL_SEC);
      await redis.set(userKey(userId), tokenHash, "EX", TTL_SEC);
      return raw;
    } catch {
      // fall through
    }
  }

  pruneMemory();
  const exp = Date.now() + TTL_SEC * 1000;
  memoryTokens.set(tokenHash, { userId, exp });
  memoryByUser.set(userId, tokenHash);
  return raw;
}

export async function consumePasswordResetToken(
  rawToken: string,
): Promise<string | null> {
  const tokenHash = hashToken(rawToken);

  if (redis) {
    try {
      await connectRedis();
      const userId = await redis.get(tokenKey(tokenHash));
      if (!userId) return null;
      await redis.del(tokenKey(tokenHash));
      await redis.del(userKey(userId));
      return userId;
    } catch {
      // fall through
    }
  }

  pruneMemory();
  const row = memoryTokens.get(tokenHash);
  if (!row || row.exp < Date.now()) {
    memoryTokens.delete(tokenHash);
    return null;
  }
  memoryTokens.delete(tokenHash);
  if (memoryByUser.get(row.userId) === tokenHash) {
    memoryByUser.delete(row.userId);
  }
  return row.userId;
}

export function buildPasswordResetUrl(rawToken: string) {
  const base = env.FRONTEND_URL.replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Deliver reset link via SMTP when configured.
 * Falls back to console log in non-production (or PASSWORD_RESET_LOG_LINKS).
 */
export async function deliverPasswordResetLink(input: {
  email: string;
  resetUrl: string;
}): Promise<void> {
  const logLinks =
    env.PASSWORD_RESET_LOG_LINKS === true ||
    (env.NODE_ENV !== "production" && !env.smtpEnabled);

  if (env.smtpEnabled) {
    try {
      const sent = await sendPasswordResetEmail({
        to: input.email,
        resetUrl: input.resetUrl,
      });
      if (sent) {
        console.info(`[password-reset] email sent to ${input.email}`);
      }
    } catch (err) {
      console.error("[password-reset] SMTP send failed:", err);
      if (env.NODE_ENV !== "production") {
        console.info(
          `[password-reset] fallback link for ${input.email}: ${input.resetUrl}`,
        );
      }
      return;
    }
  } else if (env.NODE_ENV === "production") {
    console.warn(
      "[password-reset] SMTP not configured — reset email was not sent",
    );
  }

  if (logLinks) {
    console.info(
      `[password-reset] link for ${input.email}: ${input.resetUrl}`,
    );
  }
}

export function passwordResetExposeDebugUrl() {
  return env.NODE_ENV !== "production" && !env.smtpEnabled;
}
