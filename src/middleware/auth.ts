import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../databases";
import { env } from "../config/env";
import { extractAccessToken } from "../lib/auth-cookie";
import { AppError } from "../lib/errors";
import { isAccessTokenRevoked, newTokenId } from "../modules/auth/token-revoke";

export type AuthUser = {
  id: string;
  email: string;
  role: "BUYER" | "SELLER" | "ADMIN";
  name?: string | null;
  avatarUrl?: string | null;
  kycStatus?: "NONE" | "PENDING" | "APPROVED" | "REJECTED" | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      accessToken?: string;
    }
  }
}

type JwtPayload = {
  sub: string;
  email: string;
  role: AuthUser["role"];
  name?: string | null;
  avatarUrl?: string | null;
  kycStatus?: AuthUser["kycStatus"];
  jti?: string;
  exp?: number;
  iat?: number;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: AuthUser["role"];
  kycStatus: NonNullable<AuthUser["kycStatus"]>;
};

function sessionClaimsFrom(user: AuthUser) {
  return {
    email: user.email,
    role: user.role,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    kycStatus: user.kycStatus ?? "NONE",
  };
}

export function sessionUserFromAuth(user: AuthUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role,
    kycStatus: user.kycStatus ?? "NONE",
  };
}

const ROLE_CACHE_TTL_MS = 15_000;
const roleCache = new Map<
  string,
  { user: AuthUser; expiresAt: number }
>();

export function signAccessToken(user: AuthUser) {
  return jwt.sign(sessionClaimsFrom(user), env.JWT_SECRET, {
    subject: user.id,
    jwtid: newTokenId(),
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    algorithm: "HS256",
    audience: "elloot-app",
  });
}

export function verifyAccessToken(token: string): AuthUser & {
  jti?: string;
  exp?: number;
} {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
    }) as JwtPayload & { aud?: string | string[] };
    if (payload.aud) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes("elloot-app")) {
        throw new Error("wrong audience");
      }
    }
    if (!payload.sub || !payload.email || !payload.role) {
      throw new Error("invalid payload");
    }
    if (!["BUYER", "SELLER", "ADMIN"].includes(payload.role)) {
      throw new Error("invalid role");
    }
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      name: payload.name ?? null,
      avatarUrl: payload.avatarUrl ?? null,
      kycStatus: payload.kycStatus ?? "NONE",
      jti: payload.jti,
      exp: payload.exp,
    };
  } catch {
    throw new AppError(401, "Invalid or expired token", "UNAUTHORIZED");
  }
}

/**
 * Full token gate: signature + blacklist + DB role revalidation.
 */
export async function authenticateAccessToken(token: string): Promise<{
  user: AuthUser;
  jti?: string;
  exp?: number;
}> {
  const jwtUser = verifyAccessToken(token);
  const revoked = await isAccessTokenRevoked({
    jti: jwtUser.jti,
    token,
  });
  if (revoked) {
    throw new AppError(401, "Token revoked", "TOKEN_REVOKED");
  }
  const user = await resolveAuthUserFromDb(jwtUser);
  return { user, jti: jwtUser.jti, exp: jwtUser.exp };
}

/**
 * Revalidates identity against the DB so demotions / deletions take effect
 * without waiting for JWT expiry. Short in-memory cache reduces load.
 */
export async function resolveAuthUserFromDb(
  jwtUser: AuthUser,
): Promise<AuthUser> {
  const cached = roleCache.get(jwtUser.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const row = await prisma.user.findUnique({
    where: { id: jwtUser.id },
    select: { id: true, email: true, role: true },
  });

  if (!row) {
    roleCache.delete(jwtUser.id);
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  if (!["BUYER", "SELLER", "ADMIN"].includes(row.role)) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }

  const user: AuthUser = {
    id: row.id,
    email: row.email,
    role: row.role as AuthUser["role"],
    name: jwtUser.name ?? null,
    avatarUrl: jwtUser.avatarUrl ?? null,
    kycStatus: jwtUser.kycStatus ?? "NONE",
  };
  roleCache.set(row.id, {
    user,
    expiresAt: Date.now() + ROLE_CACHE_TTL_MS,
  });
  return user;
}

/** Drop cache entry after admin role changes (optional callers). */
export function invalidateAuthUserCache(userId: string) {
  roleCache.delete(userId);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractAccessToken(req);
  if (!token) {
    return next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
  }

  void (async () => {
    try {
      const { user } = await authenticateAccessToken(token);
      req.user = user;
      req.accessToken = token;
      next();
    } catch (err) {
      next(
        err instanceof AppError
          ? err
          : new AppError(401, "Invalid or expired token", "UNAUTHORIZED"),
      );
    }
  })();
}

export function requireRole(...roles: AuthUser["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, "Forbidden", "FORBIDDEN"));
    }
    next();
  };
}
