import type { CookieOptions, Request, Response } from "express";
import { env } from "../config/env";

export const ADMIN_ACCESS_COOKIE_NAME = "elloot_admin_at";

function adminCookieCrossSite(): boolean {
  try {
    const adminOrigin = env.ADMIN_CORS_ORIGIN.split(",")[0]?.trim();
    if (!adminOrigin) return true;
    return new URL(adminOrigin).origin !== new URL(env.APP_URL).origin;
  } catch {
    return true;
  }
}

/** Parse ADMIN_JWT_EXPIRES_IN like "2h" into maxAge ms. */
export function adminJwtExpiresMs(): number {
  const raw = env.ADMIN_JWT_EXPIRES_IN.trim();
  const match = /^(\d+)([smhd])?$/i.exec(raw);
  if (!match) return 2 * 3_600_000;
  const n = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const mult =
    unit === "d"
      ? 86_400_000
      : unit === "h"
        ? 3_600_000
        : unit === "m"
          ? 60_000
          : 1_000;
  return n * mult;
}

export function adminAuthCookieOptions(): CookieOptions {
  const crossSite = adminCookieCrossSite();
  return {
    httpOnly: true,
    path: "/",
    maxAge: adminJwtExpiresMs(),
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite || env.NODE_ENV === "production",
  };
}

export function setAdminAuthCookie(res: Response, token: string) {
  res.cookie(ADMIN_ACCESS_COOKIE_NAME, token, adminAuthCookieOptions());
}

export function clearAdminAuthCookie(res: Response) {
  res.clearCookie(ADMIN_ACCESS_COOKIE_NAME, {
    ...adminAuthCookieOptions(),
    maxAge: 0,
  });
}

export function extractAdminAccessToken(req: Request): string | null {
  const cookie = req.cookies?.[ADMIN_ACCESS_COOKIE_NAME];
  if (typeof cookie === "string" && cookie.length > 0) {
    return cookie;
  }
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && header.length > 7) {
    return header.slice("Bearer ".length).trim() || null;
  }
  return null;
}
