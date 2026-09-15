import { Router } from "express";
import { z } from "zod";
import { withRlsTransaction, withServiceTransaction } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { setAuthCookie } from "../../lib/auth-cookie";
import { AppError } from "../../lib/errors";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  totpQrDataUrl,
  verifyTotpCode,
} from "../../lib/totp";
import {
  requireAuth,
  signAccessToken,
  verifyAccessToken,
  type AuthUser,
} from "../../middleware/auth";
import { authAccountLimiter, authStrictLimiter } from "../../middleware/rate-limit";
import { clientIp, createAuthSession, readUserAgent } from "./auth-sessions";
import { verifyChallengeToken } from "./two-factor.shared";

export const twoFactorRouter = Router();

const codeSchema = z.object({
  code: z.string().trim().min(6).max(12),
});

twoFactorRouter.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = { id: req.user!.id, role: req.user!.role };
    const row = await withRlsTransaction({ actor }, (tx) =>
      tx.user.findUnique({
        where: { id: actor.id },
        select: { totpEnabledAt: true, totpSecret: true },
      }),
    );
    res.json({
      enabled: Boolean(row?.totpEnabledAt && row.totpSecret),
      enabledAt: row?.totpEnabledAt?.toISOString() ?? null,
    });
  }),
);

twoFactorRouter.post(
  "/setup",
  requireAuth,
  authStrictLimiter,
  asyncHandler(async (req, res) => {
    const actor = { id: req.user!.id, role: req.user!.role };
    const user = await withRlsTransaction({ actor }, (tx) =>
      tx.user.findUnique({
        where: { id: actor.id },
        select: {
          id: true,
          email: true,
          totpEnabledAt: true,
          totpSecret: true,
        },
      }),
    );
    if (!user) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    if (user.totpEnabledAt && user.totpSecret) {
      throw new AppError(409, "2FA já está ativo", "2FA_ALREADY_ENABLED");
    }

    const { secret, otpauthUrl } = generateTotpSecret(user.email);
    await withServiceTransaction((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          totpSecret: encryptTotpSecret(secret),
          totpEnabledAt: null,
        },
      }),
    );

    const qrDataUrl = await totpQrDataUrl(otpauthUrl);
    res.json({ secret, otpauthUrl, qrDataUrl });
  }),
);

twoFactorRouter.post(
  "/enable",
  requireAuth,
  authStrictLimiter,
  asyncHandler(async (req, res) => {
    const body = codeSchema.parse(req.body);
    const actor = { id: req.user!.id, role: req.user!.role };
    const user = await withRlsTransaction({ actor }, (tx) =>
      tx.user.findUnique({
        where: { id: actor.id },
        select: { id: true, totpSecret: true, totpEnabledAt: true },
      }),
    );
    if (!user?.totpSecret) {
      throw new AppError(
        400,
        "Inicie a configuração do 2FA primeiro",
        "2FA_SETUP_REQUIRED",
      );
    }
    if (user.totpEnabledAt) {
      throw new AppError(409, "2FA já está ativo", "2FA_ALREADY_ENABLED");
    }

    const plain = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpCode(plain, body.code)) {
      throw new AppError(400, "Código inválido", "2FA_INVALID_CODE");
    }

    const enabledAt = new Date();
    await withServiceTransaction((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { totpEnabledAt: enabledAt },
      }),
    );

    res.json({ enabled: true, enabledAt: enabledAt.toISOString() });
  }),
);

twoFactorRouter.post(
  "/disable",
  requireAuth,
  authStrictLimiter,
  asyncHandler(async (req, res) => {
    const body = codeSchema.parse(req.body);
    const actor = { id: req.user!.id, role: req.user!.role };
    const user = await withRlsTransaction({ actor }, (tx) =>
      tx.user.findUnique({
        where: { id: actor.id },
        select: { id: true, totpSecret: true, totpEnabledAt: true },
      }),
    );
    if (!user?.totpEnabledAt || !user.totpSecret) {
      throw new AppError(400, "2FA não está ativo", "2FA_NOT_ENABLED");
    }

    const plain = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpCode(plain, body.code)) {
      throw new AppError(400, "Código inválido", "2FA_INVALID_CODE");
    }

    await withServiceTransaction((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { totpSecret: null, totpEnabledAt: null },
      }),
    );

    res.json({ enabled: false });
  }),
);

twoFactorRouter.post(
  "/cancel-setup",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = { id: req.user!.id, role: req.user!.role };
    await withServiceTransaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: { totpEnabledAt: true },
      });
      if (user?.totpEnabledAt) {
        throw new AppError(409, "2FA já está ativo", "2FA_ALREADY_ENABLED");
      }
      await tx.user.update({
        where: { id: actor.id },
        data: { totpSecret: null, totpEnabledAt: null },
      });
    });
    res.json({ ok: true });
  }),
);

twoFactorRouter.post(
  "/verify-login",
  authStrictLimiter,
  authAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        challengeToken: z.string().min(16),
        code: z.string().trim().min(6).max(12),
      })
      .parse(req.body);

    const challenge = await verifyChallengeToken(body.challengeToken);
    const user = await withServiceTransaction((tx) =>
      tx.user.findUnique({ where: { id: challenge.sub } }),
    );
    if (!user?.totpSecret || !user.totpEnabledAt) {
      throw new AppError(400, "2FA não está ativo", "2FA_NOT_ENABLED");
    }

    const plain = decryptTotpSecret(user.totpSecret);
    if (!verifyTotpCode(plain, body.code)) {
      throw new AppError(400, "Código inválido", "2FA_INVALID_CODE");
    }

    await withServiceTransaction((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { lastSeenAt: new Date() },
      }),
    );

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatarUrl: user.avatarUrl,
      kycStatus: user.kycStatus,
    };
    const accessToken = signAccessToken(authUser);
    const verified = verifyAccessToken(accessToken);
    if (verified.jti) {
      await withServiceTransaction((tx) =>
        createAuthSession(tx, {
          userId: user.id,
          tokenJti: verified.jti!,
          userAgent: readUserAgent(req),
          ip: clientIp(req),
        }),
      );
    }

    setAuthCookie(res, accessToken);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        role: user.role,
        kycStatus: user.kycStatus,
        createdAt: user.createdAt,
        totpEnabled: true,
      },
      accessToken,
    });
  }),
);
