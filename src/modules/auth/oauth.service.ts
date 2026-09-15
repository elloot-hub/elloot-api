import { randomBytes } from "node:crypto";
import { env } from "../../config/env";
import {
  connectRedis,
  oauthExchangeKey,
  oauthStateKey,
  redis,
  withServiceTransaction,
} from "../../databases";
import { AppError } from "../../lib/errors";
import { sanitizeUserText } from "../../lib/sanitize";
import { allocateUsername } from "../../lib/username";
import { signAccessToken } from "../../middleware/auth";
import { revokeAllUserSessions } from "./auth-sessions";
import { signChallenge, userHas2fa } from "./two-factor.shared";

export type OAuthProvider = "google" | "discord";

type OAuthProfile = {
  provider: OAuthProvider;
  providerAccountId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
};

export type OAuthExchangePayload =
  | { kind: "session"; accessToken: string }
  | {
      kind: "2fa";
      challengeToken: string;
      emailHint: string;
    };

export type OAuthCallbackResult =
  | {
      requires2fa: false;
      accessToken: string;
      user: {
        id: string;
        email: string;
        name: string | null;
        avatarUrl: string | null;
        role: "BUYER" | "SELLER" | "ADMIN";
        kycStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
        createdAt: Date;
      };
    }
  | {
      requires2fa: true;
      challengeToken: string;
      emailHint: string;
      user: {
        id: string;
        email: string;
        name: string | null;
        avatarUrl: string | null;
        role: "BUYER" | "SELLER" | "ADMIN";
        kycStatus: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
        createdAt: Date;
      };
    };

const memoryStates = new Map<string, number>();
const memoryExchange = new Map<string, { payload: string; expiresAt: number }>();

function emailHint(email: string) {
  return email.replace(
    /^(.)(.*)(@.*)$/,
    (_, a, mid, domain) =>
      `${a}${"•".repeat(Math.min(mid.length, 6))}${domain}`,
  );
}

function parseExchangePayload(raw: string): OAuthExchangePayload | null {
  try {
    const parsed = JSON.parse(raw) as OAuthExchangePayload;
    if (parsed?.kind === "session" && typeof parsed.accessToken === "string") {
      return parsed;
    }
    if (
      parsed?.kind === "2fa" &&
      typeof parsed.challengeToken === "string" &&
      typeof parsed.emailHint === "string"
    ) {
      return parsed;
    }
    // Legacy: bare JWT string
    if (raw.startsWith("eyJ")) {
      return { kind: "session", accessToken: raw };
    }
    return null;
  } catch {
    if (raw.startsWith("eyJ")) {
      return { kind: "session", accessToken: raw };
    }
    return null;
  }
}

async function saveState(state: string) {
  const key = oauthStateKey(state);
  if (redis) {
    try {
      await connectRedis();
      await redis.set(key, "1", "EX", 600);
      return;
    } catch {
      // fall through to memory
    }
  }
  memoryStates.set(state, Date.now() + 600_000);
}

async function consumeState(state: string) {
  const key = oauthStateKey(state);
  if (redis) {
    try {
      await connectRedis();
      const ok = await redis.get(key);
      if (!ok) return false;
      await redis.del(key);
      return true;
    } catch {
      // fall through to memory
    }
  }
  const expires = memoryStates.get(state);
  memoryStates.delete(state);
  return Boolean(expires && expires > Date.now());
}

/** One-time code for frontend exchange (never put JWT in the URL).
 *  Consumed with GETDEL. App callback uses sessionStorage lock to avoid
 *  double-exchange; a second call fails (code already used).
 */
export async function createOAuthExchangeCode(
  payload: OAuthExchangePayload,
) {
  const code = randomBytes(32).toString("hex");
  const key = oauthExchangeKey(code);
  const value = JSON.stringify(payload);
  if (redis) {
    try {
      await connectRedis();
      await redis.set(key, value, "EX", 120);
      return code;
    } catch {
      // fall through
    }
  }
  memoryExchange.set(code, {
    payload: value,
    expiresAt: Date.now() + 120_000,
  });
  return code;
}

export async function consumeOAuthExchangeCode(
  code: string,
): Promise<OAuthExchangePayload | null> {
  const key = oauthExchangeKey(code);
  if (redis) {
    try {
      await connectRedis();
      const raw =
        typeof redis.getdel === "function"
          ? await redis.getdel(key)
          : await (async () => {
              const v = await redis.get(key);
              if (v) await redis.del(key);
              return v;
            })();
      if (!raw) return null;
      return parseExchangePayload(raw);
    } catch {
      // fall through
    }
  }
  const row = memoryExchange.get(code);
  memoryExchange.delete(code);
  if (!row || row.expiresAt < Date.now()) {
    return null;
  }
  return parseExchangePayload(row.payload);
}

function requireGoogleConfig() {
  if (!env.googleEnabled) {
    throw new AppError(
      503,
      "Google login is not configured",
      "OAUTH_NOT_CONFIGURED",
    );
  }
}

function requireDiscordConfig() {
  if (!env.discordEnabled) {
    throw new AppError(
      503,
      "Discord login is not configured",
      "OAUTH_NOT_CONFIGURED",
    );
  }
}

export async function getGoogleAuthUrl() {
  requireGoogleConfig();
  const state = randomBytes(24).toString("hex");
  await saveState(state);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${env.APP_URL}/api/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function getDiscordAuthUrl() {
  requireDiscordConfig();
  const state = randomBytes(24).toString("hex");
  await saveState(state);

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID!);
  url.searchParams.set(
    "redirect_uri",
    `${env.APP_URL}/api/auth/discord/callback`,
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function exchangeGoogleCode(code: string): Promise<OAuthProfile> {
  requireGoogleConfig();
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${env.APP_URL}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw new AppError(401, "Google token exchange failed", "OAUTH_TOKEN_FAILED");
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new AppError(401, "Google access token missing", "OAUTH_TOKEN_FAILED");
  }

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) {
    throw new AppError(401, "Google profile fetch failed", "OAUTH_PROFILE_FAILED");
  }

  const profile = (await profileRes.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!profile.email || profile.email_verified === false) {
    throw new AppError(400, "Google account email is not verified", "OAUTH_EMAIL_REQUIRED");
  }

  return {
    provider: "google",
    providerAccountId: profile.sub,
    email: profile.email.toLowerCase(),
    name: profile.name,
    avatarUrl: profile.picture,
  };
}

async function exchangeDiscordCode(code: string): Promise<OAuthProfile> {
  requireDiscordConfig();
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.DISCORD_CLIENT_ID!,
      client_secret: env.DISCORD_CLIENT_SECRET!,
      redirect_uri: `${env.APP_URL}/api/auth/discord/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw new AppError(401, "Discord token exchange failed", "OAUTH_TOKEN_FAILED");
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new AppError(401, "Discord access token missing", "OAUTH_TOKEN_FAILED");
  }

  const profileRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!profileRes.ok) {
    throw new AppError(401, "Discord profile fetch failed", "OAUTH_PROFILE_FAILED");
  }

  const profile = (await profileRes.json()) as {
    id: string;
    email?: string | null;
    verified?: boolean;
    global_name?: string | null;
    username: string;
    avatar?: string | null;
  };

  if (!profile.email || !profile.verified) {
    throw new AppError(
      400,
      "Discord account email is required and must be verified",
      "OAUTH_EMAIL_REQUIRED",
    );
  }

  const avatarUrl = profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : undefined;

  return {
    provider: "discord",
    providerAccountId: profile.id,
    email: profile.email.toLowerCase(),
    name: profile.global_name || profile.username,
    avatarUrl,
  };
}

export async function upsertOAuthUser(profile: OAuthProfile) {
  const safeName = profile.name
    ? sanitizeUserText(profile.name, 80)
    : undefined;

  return withServiceTransaction(async (tx) => {
    const existingAccount = await tx.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      include: { user: true },
    });

    if (existingAccount) {
      // Keep profile edits from settings — OAuth must not overwrite name/avatar
      // on every login.
      return tx.user.update({
        where: { id: existingAccount.userId },
        data: { lastSeenAt: new Date() },
      });
    }

    const byEmail = await tx.user.findUnique({
      where: { email: profile.email },
    });

    if (byEmail) {
      await tx.account.create({
        data: {
          userId: byEmail.id,
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      });

      // OAuth provider proved email ownership. If the account was an
      // unverified password squat, revoke the password so the attacker
      // cannot keep logging in after the real owner claims via OAuth.
      const reclaimUnverified =
        !byEmail.emailVerifiedAt && Boolean(byEmail.passwordHash);

      const updated = await tx.user.update({
        where: { id: byEmail.id },
        data: {
          // Only fill blanks on first link — never clobber existing profile.
          name: byEmail.name ?? safeName ?? null,
          avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl ?? null,
          emailVerifiedAt: new Date(),
          lastSeenAt: new Date(),
          ...(reclaimUnverified ? { passwordHash: null } : {}),
        },
      });

      if (reclaimUnverified) {
        await revokeAllUserSessions(tx, byEmail.id);
      }

      return updated;
    }

    return tx.user.create({
      data: {
        email: profile.email,
        name: safeName,
        username: await allocateUsername(tx, {
          email: profile.email,
          name: safeName,
        }),
        avatarUrl: profile.avatarUrl,
        role: "BUYER",
        emailVerifiedAt: new Date(),
        lastSeenAt: new Date(),
        accounts: {
          create: {
            provider: profile.provider,
            providerAccountId: profile.providerAccountId,
          },
        },
      },
    });
  });
}

export async function handleOAuthCallback(
  provider: OAuthProvider,
  code: string | undefined,
  state: string | undefined,
): Promise<OAuthCallbackResult> {
  if (!code || !state) {
    throw new AppError(400, "Missing OAuth code or state", "OAUTH_INVALID_REQUEST");
  }

  const validState = await consumeState(state);
  if (!validState) {
    throw new AppError(400, "Invalid or expired OAuth state", "OAUTH_INVALID_STATE");
  }

  const profile =
    provider === "google"
      ? await exchangeGoogleCode(code)
      : await exchangeDiscordCode(code);

  const user = await upsertOAuthUser(profile);
  const publicUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    kycStatus: user.kycStatus,
    createdAt: user.createdAt,
  };

  if (userHas2fa(user)) {
    return {
      requires2fa: true,
      challengeToken: signChallenge({ id: user.id, email: user.email }),
      emailHint: emailHint(user.email),
      user: publicUser,
    };
  }

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    avatarUrl: user.avatarUrl,
    kycStatus: user.kycStatus,
  });

  return {
    requires2fa: false,
    accessToken,
    user: publicUser,
  };
}

/** Redirect with one-time code only — never put the JWT in the query string. */
export async function buildFrontendRedirect(result: OAuthCallbackResult) {
  const payload: OAuthExchangePayload = result.requires2fa
    ? {
        kind: "2fa",
        challengeToken: result.challengeToken,
        emailHint: result.emailHint,
      }
    : { kind: "session", accessToken: result.accessToken };

  const code = await createOAuthExchangeCode(payload);
  const url = new URL("/auth/callback", env.FRONTEND_URL);
  url.searchParams.set("code", code);
  return url.toString();
}
