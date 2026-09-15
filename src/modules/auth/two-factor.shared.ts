import jwt from "jsonwebtoken";
import { connectRedis, redis } from "../../databases";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { newTokenId } from "./token-revoke";

type ChallengePayload = {
  typ: "2fa_challenge";
  sub: string;
  email: string;
  jti: string;
};

const CHALLENGE_TTL_SEC = 10 * 60;
const memoryUsed = new Map<string, number>();

function usedKey(jti: string) {
  return `elloot:2fa:used:${jti}`;
}

async function markUsed(jti: string): Promise<boolean> {
  if (redis) {
    try {
      await connectRedis();
      const ok = await redis.set(
        usedKey(jti),
        "1",
        "EX",
        CHALLENGE_TTL_SEC,
        "NX",
      );
      return ok === "OK";
    } catch {
      /* fall through */
    }
  }
  const now = Date.now();
  for (const [k, exp] of memoryUsed) {
    if (exp < now) memoryUsed.delete(k);
  }
  if (memoryUsed.has(jti)) return false;
  memoryUsed.set(jti, now + CHALLENGE_TTL_SEC * 1000);
  return true;
}

export function signChallenge(user: { id: string; email: string }) {
  const jti = newTokenId();
  return jwt.sign(
    { typ: "2fa_challenge", email: user.email },
    env.JWT_SECRET,
    {
      subject: user.id,
      jwtid: jti,
      expiresIn: "10m",
      audience: "elloot-2fa",
      algorithm: "HS256",
    },
  );
}

/** Verify + burn challenge (one-time). */
export async function verifyChallengeToken(
  token: string,
): Promise<ChallengePayload> {
  let payload: jwt.JwtPayload & { typ?: string; email?: string };
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "elloot-2fa",
    }) as jwt.JwtPayload & { typ?: string; email?: string };
  } catch {
    throw new AppError(
      401,
      "Desafio 2FA inválido ou expirado",
      "2FA_CHALLENGE_INVALID",
    );
  }

  if (payload.typ !== "2fa_challenge" || !payload.sub || !payload.email) {
    throw new AppError(
      401,
      "Desafio 2FA inválido ou expirado",
      "2FA_CHALLENGE_INVALID",
    );
  }

  // Legacy challenges without jti: reject (force re-login).
  if (!payload.jti) {
    throw new AppError(
      401,
      "Desafio 2FA inválido ou expirado",
      "2FA_CHALLENGE_INVALID",
    );
  }

  const firstUse = await markUsed(payload.jti);
  if (!firstUse) {
    throw new AppError(
      401,
      "Desafio 2FA já utilizado. Faça login novamente.",
      "2FA_CHALLENGE_REUSED",
    );
  }

  return {
    typ: "2fa_challenge",
    sub: payload.sub,
    email: payload.email,
    jti: payload.jti,
  };
}

export function userHas2fa(user: {
  totpEnabledAt: Date | null;
  totpSecret: string | null;
}) {
  return Boolean(user.totpEnabledAt && user.totpSecret);
}
