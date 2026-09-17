import { Router } from "express";
import { z } from "zod";
import { withServiceTransaction } from "../../databases";
import { AppError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import {
  clearAdminAuthCookie,
  extractAdminAccessToken,
  setAdminAuthCookie,
} from "../../lib/admin-auth-cookie";
import { safePasswordCompare } from "../../lib/safe-password";
import { decryptTotpSecret, verifyTotpCode } from "../../lib/totp";
import {
  adminSessionUserFrom,
  requireAdminAuth,
  signAdminAccessToken,
  verifyAdminAccessToken,
} from "../../middleware/admin-auth";
import {
  adminAuthAccountLimiter,
  adminAuthStrictLimiter,
} from "../../middleware/rate-limit";
import { userHas2fa } from "../auth/two-factor.shared";
import {
  signAdminChallenge,
  verifyAndConsumeAdminChallenge,
} from "./admin-2fa-challenge";
import {
  isAdminAccessTokenRevoked,
  revokeAdminAccessToken,
} from "./admin-token-revoke";

export const adminAuthRouter = Router();

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(72),
});

const verify2faSchema = z.object({
  challengeToken: z.string().min(16),
  code: z.string().trim().min(6).max(12),
});

function emailHint(email: string) {
  return email.replace(
    /^(.)(.*)(@.*)$/,
    (_, a, mid, domain) =>
      `${a}${"•".repeat(Math.min(mid.length, 6))}${domain}`,
  );
}

function invalidCredentials(): never {
  throw new AppError(401, "Invalid credentials", "INVALID_CREDENTIALS");
}

adminAuthRouter.post(
  "/login",
  adminAuthStrictLimiter,
  adminAuthAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const email = body.email.toLowerCase();

    const row = await withServiceTransaction(async (tx) =>
      tx.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          passwordHash: true,
          totpSecret: true,
          totpEnabledAt: true,
        },
      }),
    );

    // Always run bcrypt (dummy hash if missing) — no 403 before compare.
    const passwordOk = await safePasswordCompare(
      body.password,
      row?.passwordHash,
    );

    if (!passwordOk || !row || row.role !== "ADMIN") {
      invalidCredentials();
    }

    if (userHas2fa(row)) {
      res.json({
        requires2fa: true,
        challengeToken: signAdminChallenge({
          id: row.id,
          email: row.email,
        }),
        emailHint: emailHint(row.email),
      });
      return;
    }

    await withServiceTransaction(async (tx) => {
      await tx.user.update({
        where: { id: row.id },
        data: { lastSeenAt: new Date() },
      });
    });

    const accessToken = signAdminAccessToken(row);
    setAdminAuthCookie(res, accessToken);

    res.json({
      user: adminSessionUserFrom({
        id: row.id,
        email: row.email,
        name: row.name,
        role: "ADMIN",
      }),
    });
  }),
);

adminAuthRouter.post(
  "/verify-2fa",
  adminAuthStrictLimiter,
  adminAuthAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = verify2faSchema.parse(req.body);
    const challenge = await verifyAndConsumeAdminChallenge(body.challengeToken);

    const user = await withServiceTransaction(async (tx) =>
      tx.user.findUnique({
        where: { id: challenge.sub },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          totpSecret: true,
          totpEnabledAt: true,
        },
      }),
    );

    // Uniform failure — do not reveal role / 2FA state differences.
    if (
      !user ||
      user.role !== "ADMIN" ||
      !user.totpSecret ||
      !user.totpEnabledAt
    ) {
      invalidCredentials();
    }

    const plain = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpCode(plain, body.code)) {
      throw new AppError(400, "Código inválido", "2FA_INVALID_CODE");
    }

    await withServiceTransaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lastSeenAt: new Date() },
      });
    });

    const accessToken = signAdminAccessToken(user);
    setAdminAuthCookie(res, accessToken);

    res.json({
      user: adminSessionUserFrom({
        id: user.id,
        email: user.email,
        name: user.name,
        role: "ADMIN",
      }),
    });
  }),
);

adminAuthRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = extractAdminAccessToken(req);
    if (token) {
      try {
        const payload = verifyAdminAccessToken(token);
        await revokeAdminAccessToken(token, {
          jti: payload.jti,
          expiresAtMs: payload.exp ? payload.exp * 1000 : undefined,
        });
      } catch {
        /* ignore invalid token on logout */
      }
    }
    clearAdminAuthCookie(res);
    res.json({ ok: true });
  }),
);

adminAuthRouter.get(
  "/session",
  asyncHandler(async (req, res) => {
    const token = extractAdminAccessToken(req);
    if (!token) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }

    const payload = verifyAdminAccessToken(token);
    const revoked = await isAdminAccessTokenRevoked({
      jti: payload.jti,
      token,
    });
    if (revoked) {
      throw new AppError(401, "Token revoked", "TOKEN_REVOKED");
    }

    res.json({ user: adminSessionUserFrom(payload) });
  }),
);

adminAuthRouter.get(
  "/me",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const user = await withServiceTransaction(async (tx) =>
      tx.user.findUnique({
        where: { id: req.user!.id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          kycStatus: true,
          createdAt: true,
          lastSeenAt: true,
        },
      }),
    );

    if (!user || user.role !== "ADMIN") {
      throw new AppError(403, "Admin access required", "FORBIDDEN");
    }

    res.json({ user });
  }),
);
