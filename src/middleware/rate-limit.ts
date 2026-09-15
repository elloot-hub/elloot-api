import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { HybridRateLimitStore } from "./rate-limit-store";

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function emailFromBody(req: Request): string {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/** IP + email when present — slows credential stuffing across accounts/IPs. */
function authKeyGenerator(prefix: string) {
  return (req: Request) => {
    const email = emailFromBody(req);
    const ip = clientIp(req);
    return email ? `${prefix}:${ip}:${email}` : `${prefix}:${ip}`;
  };
}

/** Email-only (or IP if no email) — blocks stuffing the same account from many IPs. */
function accountKeyGenerator(prefix: string) {
  return (req: Request) => {
    const email = emailFromBody(req);
    if (email) return `${prefix}:acct:${email}`;
    return `${prefix}:ip:${clientIp(req)}`;
  };
}

const authMessage = {
  error: {
    code: "RATE_LIMITED",
    message: "Too many auth attempts. Try again later.",
  },
} as const;

const adminAuthMessage = {
  error: {
    code: "RATE_LIMITED",
    message: "Too many admin login attempts. Try again later.",
  },
} as const;

/** Login / register / oauth exchange / 2FA verify — per IP (+ email). */
export const authStrictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new HybridRateLimitStore("auth"),
  keyGenerator: authKeyGenerator("auth"),
  message: authMessage,
  validate: { keyGeneratorIpFallback: false },
});

/** Same window, stricter per-account (email) cap. */
export const authAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new HybridRateLimitStore("auth-acct"),
  keyGenerator: accountKeyGenerator("auth"),
  message: authMessage,
  validate: { keyGeneratorIpFallback: false },
});

/** OAuth start redirects — moderate. */
export const authOauthStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("oauth-start"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
    },
  },
});

/** Media uploads. */
export const mediaUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("media"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Upload rate limit exceeded. Try again later.",
    },
  },
});

/** Admin panel login — very tight per IP+email. */
export const adminAuthStrictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new HybridRateLimitStore("admin-auth"),
  keyGenerator: authKeyGenerator("admin"),
  message: adminAuthMessage,
  validate: { keyGeneratorIpFallback: false },
});

/** Admin — per-account cap independent of IP rotation. */
export const adminAuthAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new HybridRateLimitStore("admin-auth-acct"),
  keyGenerator: accountKeyGenerator("admin"),
  message: adminAuthMessage,
  validate: { keyGeneratorIpFallback: false },
});

/** General API abuse brake (per IP). */
export const apiGeneralLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("api"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Slow down.",
    },
  },
});

/** Wallet payouts — sensitive money movement. */
export const payoutCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("payout"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many payout requests. Try again later.",
    },
  },
});

/** KYC document submissions. */
export const kycSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("kyc"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many verification submissions. Try again later.",
    },
  },
});

/** Efi PIX sync polling (UI polls ~every 5s). */
export const paymentSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("pay-sync"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many payment sync requests. Slow down.",
    },
  },
});

/** Sandbox payment confirm. */
export const sandboxConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new HybridRateLimitStore("sandbox"),
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many sandbox confirms. Try again later.",
    },
  },
});
