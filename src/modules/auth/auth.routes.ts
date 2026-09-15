import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "../../config/env";
import { withRlsTransaction, withServiceTransaction } from "../../databases";
import { AppError } from "../../lib/errors";
import { asyncHandler } from "../../lib/async-handler";
import { clearAuthCookie, extractAccessToken, setAuthCookie } from "../../lib/auth-cookie";
import { routeParam } from "../../lib/route-param";
import { sanitizeUserText } from "../../lib/sanitize";
import { assertAllowedAvatarUrl } from "../../lib/avatar-url";
import { safePasswordCompare } from "../../lib/safe-password";
import { passwordSchema } from "../../lib/password-policy";
import {
  allocateUsername,
  assertNameChangeAllowed,
  BIO_MAX,
  ensureUserUsername,
  NAME_CHANGE_COOLDOWN_DAYS,
  nameChangeAvailableAt,
  namesAreEqual,
} from "../../lib/username";
import {
  requireAuth,
  sessionUserFromAuth,
  signAccessToken,
  verifyAccessToken,
} from "../../middleware/auth";
import {
  authAccountLimiter,
  authOauthStartLimiter,
  authStrictLimiter,
} from "../../middleware/rate-limit";
import {
  clientIp,
  createAuthSession,
  ensureAuthSession,
  parseUserAgent,
  readUserAgent,
  revokeAllUserSessions,
  revokeAuthSessionById,
} from "./auth-sessions";
import { isAccessTokenRevoked, revokeAccessToken } from "./token-revoke";
import { signChallenge, userHas2fa } from "./two-factor.shared";
import {
  buildFrontendRedirect,
  consumeOAuthExchangeCode,
  getDiscordAuthUrl,
  getGoogleAuthUrl,
  handleOAuthCallback,
} from "./oauth.service";
import {
  buildPasswordResetUrl,
  consumePasswordResetToken,
  deliverPasswordResetLink,
  passwordResetExposeDebugUrl,
  storePasswordResetToken,
} from "./password-reset";

export const authRouter = Router();

function issueAccessToken(user: {
  id: string;
  email: string;
  role: "BUYER" | "SELLER" | "ADMIN";
  name?: string | null;
  avatarUrl?: string | null;
  kycStatus?: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
}) {
  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    avatarUrl: user.avatarUrl,
    kycStatus: user.kycStatus,
  });
  const payload = verifyAccessToken(accessToken);
  return { accessToken, jti: payload.jti };
}

async function persistLoginSession(
  req: Parameters<typeof clientIp>[0],
  userId: string,
  jti: string | undefined,
) {
  if (!jti) return;
  await withServiceTransaction(async (tx) => {
    await createAuthSession(tx, {
      userId,
      tokenJti: jti,
      userAgent: readUserAgent(req),
      ip: clientIp(req),
    });
  });
}

function syncAuthCookie(
  res: Parameters<typeof setAuthCookie>[0],
  user: {
    id: string;
    email: string;
    role: "BUYER" | "SELLER" | "ADMIN";
    name?: string | null;
    avatarUrl?: string | null;
    kycStatus?: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
  },
  current?: {
    name?: string | null;
    avatarUrl?: string | null;
    role?: string;
    kycStatus?: string | null;
  },
) {
  const stale =
    !current ||
    (current.name ?? null) !== (user.name ?? null) ||
    (current.avatarUrl ?? null) !== (user.avatarUrl ?? null) ||
    current.role !== user.role ||
    (current.kycStatus ?? "NONE") !== (user.kycStatus ?? "NONE");
  if (!stale) return;
  setAuthCookie(
    res,
    signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatarUrl: user.avatarUrl,
      kycStatus: user.kycStatus,
    }),
  );
}

const registerSchema = z.object({
  email: z.email(),
  password: passwordSchema,
  name: z.string().trim().min(2).max(80).optional(),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128),
  password: passwordSchema,
});

const oauthExchangeSchema = z.object({
  code: z.string().min(16).max(128),
});

authRouter.get("/providers", (_req, res) => {
  res.json({
    providers: {
      email: true,
      google: env.googleEnabled,
      discord: env.discordEnabled,
    },
  });
});

authRouter.post(
  "/register",
  authStrictLimiter,
  authAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const name = body.name ? sanitizeUserText(body.name, 80) : undefined;
    const email = body.email.toLowerCase();

    async function ambiguousRegisterResponse() {
      // Match real create path cost when possible.
      await bcrypt.hash(body.password, 12);
      res.status(201).json({
        user: null,
        accessToken: null,
        message:
          "Se este e-mail estiver disponível, a conta foi criada. Caso já exista, entre ou recupere a senha.",
      });
    }

    let user: {
      id: string;
      email: string;
      name: string | null;
      username: string | null;
      bio: string | null;
      avatarUrl: string | null;
      role: "BUYER" | "SELLER" | "ADMIN";
      kycStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
      createdAt: Date;
    } | null = null;

    try {
      user = await withServiceTransaction(async (tx) => {
        const existing = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });
        if (existing) return null;

        const passwordHash = await bcrypt.hash(body.password, 12);
        const username = await allocateUsername(tx, { email, name });
        return tx.user.create({
          data: {
            email,
            passwordHash,
            name,
            username,
            role: "BUYER",
            emailVerifiedAt: null,
            lastSeenAt: new Date(),
          },
          select: {
            id: true,
            email: true,
            name: true,
            username: true,
            bio: true,
            avatarUrl: true,
            role: true,
            kycStatus: true,
            createdAt: true,
          },
        });
      });
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "";
      if (code === "P2002") {
        await ambiguousRegisterResponse();
        return;
      }
      throw err;
    }

    if (!user) {
      await ambiguousRegisterResponse();
      return;
    }

    const { accessToken, jti } = issueAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatarUrl: user.avatarUrl,
      kycStatus: user.kycStatus,
    });
    await persistLoginSession(req, user.id, jti);
    setAuthCookie(res, accessToken);

    res.status(201).json({
      user,
      accessToken,
      message: "Conta criada com sucesso.",
    });
  }),
);

authRouter.post(
  "/login",
  authStrictLimiter,
  authAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const email = body.email.toLowerCase();

    const user = await withServiceTransaction(async (tx) =>
      tx.user.findUnique({ where: { email } }),
    );

    const valid = await safePasswordCompare(body.password, user?.passwordHash);
    if (!valid || !user) {
      // Uniform message to reduce account enumeration.
      throw new AppError(401, "Invalid credentials", "INVALID_CREDENTIALS");
    }

    if (userHas2fa(user)) {
      const challengeToken = signChallenge({
        id: user.id,
        email: user.email,
      });
      res.json({
        requires2fa: true,
        challengeToken,
        emailHint: user.email.replace(
          /^(.)(.*)(@.*)$/,
          (_, a, mid, domain) =>
            `${a}${"•".repeat(Math.min(mid.length, 6))}${domain}`,
        ),
      });
      return;
    }

    await withServiceTransaction(async (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { lastSeenAt: new Date() },
      }),
    );

    const { accessToken, jti } = issueAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      avatarUrl: user.avatarUrl,
      kycStatus: user.kycStatus,
    });
    await persistLoginSession(req, user.id, jti);
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
      },
      accessToken,
    });
  }),
);

authRouter.post(
  "/forgot-password",
  authStrictLimiter,
  authAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = forgotPasswordSchema.parse(req.body);
    const email = body.email.toLowerCase();

    const user = await withServiceTransaction(async (tx) =>
      tx.user.findUnique({
        where: { email },
        select: { id: true, email: true, passwordHash: true },
      }),
    );

    // Always 200 — do not reveal whether the email exists.
    if (!user?.passwordHash) {
      res.json({ ok: true });
      return;
    }

    const rawToken = await storePasswordResetToken(user.id);
    const resetUrl = buildPasswordResetUrl(rawToken);
    await deliverPasswordResetLink({ email: user.email, resetUrl });

    res.json({
      ok: true,
      ...(passwordResetExposeDebugUrl() ? { resetUrl } : {}),
    });
  }),
);

authRouter.post(
  "/reset-password",
  authStrictLimiter,
  asyncHandler(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body);
    const userId = await consumePasswordResetToken(body.token);
    if (!userId) {
      throw new AppError(
        400,
        "Link inválido ou expirado. Solicite um novo.",
        "RESET_TOKEN_INVALID",
      );
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    await withServiceTransaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash },
      });
      await revokeAllUserSessions(tx, userId);
    });

    clearAuthCookie(res);
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = extractAccessToken(req);
    if (token) {
      try {
        const payload = verifyAccessToken(token);
        await revokeAccessToken(token, {
          jti: payload.jti,
          expiresAtMs: payload.exp ? payload.exp * 1000 : undefined,
        });
        if (payload.jti) {
          await withServiceTransaction(async (tx) => {
            await tx.authSession.updateMany({
              where: { tokenJti: payload.jti!, revokedAt: null },
              data: { revokedAt: new Date() },
            });
          });
        }
      } catch {
        // still clear cookie
      }
    }
    clearAuthCookie(res);
    res.json({ ok: true });
  }),
);

/** Fast session from JWT claims — no DB. Used by the navbar. */
authRouter.get(
  "/session",
  asyncHandler(async (req, res) => {
    const token = extractAccessToken(req);
    if (!token) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }

    const payload = verifyAccessToken(token);
    const revoked = await isAccessTokenRevoked({
      jti: payload.jti,
      token,
    });
    if (revoked) {
      throw new AppError(401, "Token revoked", "TOKEN_REVOKED");
    }

    res.json({ user: sessionUserFromAuth(payload) });
  }),
);

/** Exchange one-time OAuth code for session (sets httpOnly cookie + returns token). */
authRouter.post(
  "/oauth/exchange",
  authStrictLimiter,
  authAccountLimiter,
  asyncHandler(async (req, res) => {
    const body = oauthExchangeSchema.parse(req.body);
    const payload = await consumeOAuthExchangeCode(body.code);
    if (!payload) {
      throw new AppError(
        400,
        "Invalid or expired OAuth code",
        "OAUTH_EXCHANGE_INVALID",
      );
    }

    if (payload.kind === "2fa") {
      res.json({
        requires2fa: true,
        challengeToken: payload.challengeToken,
        emailHint: payload.emailHint,
      });
      return;
    }

    const accessToken = payload.accessToken;
    const authUser = verifyAccessToken(accessToken);
    const actor = { id: authUser.id, role: authUser.role };
    const user = await withServiceTransaction(async (tx) =>
      tx.user.findUnique({
        where: { id: actor.id },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          role: true,
          kycStatus: true,
          createdAt: true,
        },
      }),
    );

    if (!user) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }

    if (authUser.jti) {
      await withServiceTransaction(async (tx) => {
        await ensureAuthSession(tx, {
          userId: user.id,
          tokenJti: authUser.jti!,
          userAgent: readUserAgent(req),
          ip: clientIp(req),
        });
      });
    }

    setAuthCookie(res, accessToken);
    res.json({ user, accessToken });
  }),
);

const meSelect = {
  id: true,
  email: true,
  name: true,
  username: true,
  bio: true,
  avatarUrl: true,
  role: true,
  kycStatus: true,
  pixKey: true,
  phone: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  createdAt: true,
  totpEnabledAt: true,
  accounts: {
    select: { provider: true, createdAt: true },
  },
} as const;

function serializeMeUser<
  T extends { nameChangedAt?: Date | null; totpEnabledAt?: Date | null },
>(user: T) {
  const nameChangedAt = user.nameChangedAt ?? null;
  const availableAt = nameChangeAvailableAt(nameChangedAt);
  return {
    ...user,
    nameChangedAt: nameChangedAt ? nameChangedAt.toISOString() : null,
    nameChangeAvailableAt: availableAt ? availableAt.toISOString() : null,
    nameChangeCooldownDays: NAME_CHANGE_COOLDOWN_DAYS,
    totpEnabled: Boolean(user.totpEnabledAt),
    totpEnabledAt: user.totpEnabledAt
      ? user.totpEnabledAt.toISOString()
      : null,
  };
}

const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(80).nullable().optional(),
    bio: z.string().trim().max(BIO_MAX).nullable().optional(),
    avatarUrl: z.url().nullable().optional(),
    pixKey: z.string().trim().min(3).max(140).nullable().optional(),
    phone: z.string().trim().min(10).max(20).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = { id: req.user!.id, role: req.user!.role };
    const user = await withRlsTransaction({ actor }, async (tx) => {
      const row = await tx.user.findUnique({
        where: { id: actor.id },
        select: { ...meSelect, email: true },
      });
      if (!row) return null;
      if (!row.username) {
        await ensureUserUsername(tx, {
          id: row.id,
          email: row.email,
          name: row.name,
          username: row.username,
        });
        return tx.user.findUnique({
          where: { id: actor.id },
          select: meSelect,
        });
      }
      return row;
    });

    if (!user) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }

    syncAuthCookie(res, user, req.user);
    res.json({ user: serializeMeUser(user) });
  }),
);

authRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = updateMeSchema.parse(req.body);
    const actor = { id: req.user!.id, role: req.user!.role };

    const user = await withRlsTransaction({ actor }, async (tx) => {
      const current = await tx.user.findUnique({
        where: { id: actor.id },
        select: {
          id: true,
          email: true,
          name: true,
          username: true,
          nameChangedAt: true,
          phone: true,
        },
      });
      if (!current) {
        throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      }

      let nextName: string | null | undefined = undefined;
      let nextUsername: string | undefined = undefined;
      let nextNameChangedAt: Date | undefined = undefined;

      if (body.name !== undefined) {
        nextName =
          body.name === null ? null : sanitizeUserText(body.name, 80);

        if (!namesAreEqual(current.name, nextName)) {
          // First name ever set does not consume the cooldown window.
          if (current.name?.trim()) {
            assertNameChangeAllowed(current.nameChangedAt);
          }
          nextNameChangedAt = new Date();
          nextUsername = await allocateUsername(tx, {
            email: current.email,
            name: nextName,
            excludeUserId: current.id,
          });
          if (nextUsername === current.username) {
            nextUsername = undefined;
          }
        }
      }

      try {
        return await tx.user.update({
          where: { id: actor.id },
          data: {
            name: nextName,
            username: nextUsername,
            nameChangedAt: nextNameChangedAt,
            bio:
              body.bio === undefined
                ? undefined
                : body.bio === null || body.bio.trim() === ""
                  ? null
                  : sanitizeUserText(body.bio, BIO_MAX),
            avatarUrl:
              body.avatarUrl === undefined
                ? undefined
                : assertAllowedAvatarUrl(body.avatarUrl),
            pixKey:
              body.pixKey === undefined
                ? undefined
                : body.pixKey === null
                  ? null
                  : sanitizeUserText(body.pixKey, 140),
            phone:
              body.phone === undefined
                ? undefined
                : body.phone === null
                  ? null
                  : sanitizeUserText(body.phone.replace(/\s+/g, ""), 20),
            phoneVerifiedAt:
              body.phone === undefined
                ? undefined
                : body.phone === null
                  ? null
                  : body.phone.replace(/\D/g, "") ===
                      (current.phone ?? "").replace(/\D/g, "")
                    ? undefined
                    : null,
          },
          select: meSelect,
        });
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : "";
        if (code === "P2002") {
          throw new AppError(
            409,
            "Este nome de usuário já está em uso. Tente outro nome de exibição.",
            "USERNAME_TAKEN",
          );
        }
        throw err;
      }
    });

    syncAuthCookie(res, user);
    res.json({ user: serializeMeUser(user) });
  }),
);

authRouter.get(
  "/sessions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = { id: req.user!.id, role: req.user!.role };
    const token = req.accessToken ?? extractAccessToken(req);
    const currentJti = token ? verifyAccessToken(token).jti : undefined;

    const rows = await withRlsTransaction({ actor }, async (tx) => {
      if (currentJti) {
        await ensureAuthSession(tx, {
          userId: actor.id,
          tokenJti: currentJti,
          userAgent: readUserAgent(req),
          ip: clientIp(req),
        });
      }

      return tx.authSession.findMany({
        where: { userId: actor.id, revokedAt: null },
        orderBy: { lastSeenAt: "desc" },
        select: {
          id: true,
          userAgent: true,
          ip: true,
          lastSeenAt: true,
          createdAt: true,
          tokenJti: true,
        },
      });
    });

    res.json({
      sessions: rows.map((row) => {
        const parsed = parseUserAgent(row.userAgent);
        return {
          id: row.id,
          browser: parsed.browser,
          os: parsed.os,
          ip: row.ip,
          lastSeenAt: row.lastSeenAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          current: Boolean(currentJti && row.tokenJti === currentJti),
        };
      }),
    });
  }),
);

authRouter.delete(
  "/sessions/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = routeParam(req.params.id);
    const actor = { id: req.user!.id, role: req.user!.role };
    const token = req.accessToken ?? extractAccessToken(req);
    const currentJti = token ? verifyAccessToken(token).jti : undefined;

    const revoked = await withRlsTransaction({ actor }, (tx) =>
      revokeAuthSessionById(tx, { userId: actor.id, sessionId }),
    );

    if (!revoked) {
      throw new AppError(404, "Session not found", "SESSION_NOT_FOUND");
    }

    const isCurrent = Boolean(currentJti && revoked.tokenJti === currentJti);
    if (isCurrent) {
      clearAuthCookie(res);
    }

    res.json({ ok: true, current: isCurrent });
  }),
);

authRouter.get(
  "/google",
  authOauthStartLimiter,
  asyncHandler(async (_req, res) => {
    const url = await getGoogleAuthUrl();
    res.redirect(url);
  }),
);

authRouter.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    const result = await handleOAuthCallback(
      "google",
      typeof req.query.code === "string" ? req.query.code : undefined,
      typeof req.query.state === "string" ? req.query.state : undefined,
    );

    if (req.query.format === "json") {
      // Still avoid returning long-lived token in browser redirects; JSON
      // clients must be trusted (dev/tools). Prefer oauth/exchange.
      res.json({
        user: result.user,
        requires2fa: result.requires2fa,
        exchangeHint: "Use browser redirect flow; token omitted in json mode",
      });
      return;
    }

    res.redirect(await buildFrontendRedirect(result));
  }),
);

authRouter.get(
  "/discord",
  authOauthStartLimiter,
  asyncHandler(async (_req, res) => {
    const url = await getDiscordAuthUrl();
    res.redirect(url);
  }),
);

authRouter.get(
  "/discord/callback",
  asyncHandler(async (req, res) => {
    const result = await handleOAuthCallback(
      "discord",
      typeof req.query.code === "string" ? req.query.code : undefined,
      typeof req.query.state === "string" ? req.query.state : undefined,
    );

    if (req.query.format === "json") {
      res.json({
        user: result.user,
        requires2fa: result.requires2fa,
        exchangeHint: "Use browser redirect flow; token omitted in json mode",
      });
      return;
    }

    res.redirect(await buildFrontendRedirect(result));
  }),
);
