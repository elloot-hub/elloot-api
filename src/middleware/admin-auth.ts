import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../databases";
import { env } from "../config/env";
import { extractAdminAccessToken } from "../lib/admin-auth-cookie";
import { AppError } from "../lib/errors";
import type { AuthUser } from "./auth";
import {
  isAdminAccessTokenRevoked,
  newTokenId,
} from "../modules/admin-auth/admin-token-revoke";

export const ADMIN_JWT_AUDIENCE = "elloot-admin";

type AdminJwtPayload = {
  sub: string;
  email: string;
  role: "ADMIN";
  name?: string | null;
  jti?: string;
  exp?: number;
  aud?: string;
};

const ADMIN_ROLE_CACHE_TTL_MS = 15_000;
const adminRoleCache = new Map<
  string,
  { user: AuthUser; expiresAt: number }
>();

export type AdminSessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN";
};

export function signAdminAccessToken(user: {
  id: string;
  email: string;
  name?: string | null;
}) {
  return jwt.sign(
    {
      email: user.email,
      role: "ADMIN" as const,
      name: user.name ?? null,
    },
    env.ADMIN_JWT_SECRET,
    {
      subject: user.id,
      jwtid: newTokenId(),
      expiresIn: env.ADMIN_JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
      algorithm: "HS256",
      audience: ADMIN_JWT_AUDIENCE,
    },
  );
}

export function verifyAdminAccessToken(token: string): AuthUser & {
  jti?: string;
  exp?: number;
} {
  try {
    const payload = jwt.verify(token, env.ADMIN_JWT_SECRET, {
      algorithms: ["HS256"],
      audience: ADMIN_JWT_AUDIENCE,
    }) as AdminJwtPayload;

    if (!payload.sub || !payload.email || payload.role !== "ADMIN") {
      throw new Error("invalid admin payload");
    }

    return {
      id: payload.sub,
      email: payload.email,
      role: "ADMIN",
      name: payload.name ?? null,
      avatarUrl: null,
      kycStatus: "NONE",
      jti: payload.jti,
      exp: payload.exp,
    };
  } catch {
    throw new AppError(401, "Invalid or expired admin token", "UNAUTHORIZED");
  }
}

async function resolveAdminFromDb(jwtUser: AuthUser): Promise<AuthUser> {
  const cached = adminRoleCache.get(jwtUser.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const row = await prisma.user.findUnique({
    where: { id: jwtUser.id },
    select: { id: true, email: true, role: true, name: true },
  });

  if (!row || row.role !== "ADMIN") {
    adminRoleCache.delete(jwtUser.id);
    throw new AppError(403, "Admin access required", "FORBIDDEN");
  }

  const user: AuthUser = {
    id: row.id,
    email: row.email,
    role: "ADMIN",
    name: row.name ?? jwtUser.name ?? null,
    avatarUrl: null,
    kycStatus: "NONE",
  };

  adminRoleCache.set(row.id, {
    user,
    expiresAt: Date.now() + ADMIN_ROLE_CACHE_TTL_MS,
  });
  return user;
}

export function invalidateAdminAuthCache(userId: string) {
  adminRoleCache.delete(userId);
}

export async function authenticateAdminAccessToken(token: string): Promise<{
  user: AuthUser;
  jti?: string;
  exp?: number;
}> {
  const jwtUser = verifyAdminAccessToken(token);
  const revoked = await isAdminAccessTokenRevoked({
    jti: jwtUser.jti,
    token,
  });
  if (revoked) {
    throw new AppError(401, "Admin token revoked", "TOKEN_REVOKED");
  }
  const user = await resolveAdminFromDb(jwtUser);
  return { user, jti: jwtUser.jti, exp: jwtUser.exp };
}

export function requireAdminAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const token = extractAdminAccessToken(req);
  if (!token) {
    return next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
  }

  void (async () => {
    try {
      const { user } = await authenticateAdminAccessToken(token);
      req.user = user;
      req.accessToken = token;
      next();
    } catch (err) {
      next(
        err instanceof AppError
          ? err
          : new AppError(401, "Invalid or expired admin token", "UNAUTHORIZED"),
      );
    }
  })();
}

export function adminSessionUserFrom(user: AuthUser): AdminSessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: "ADMIN",
  };
}
