import jwt from "jsonwebtoken";
import { connectRedis, redis } from "../../databases";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { newTokenId } from "../auth/token-revoke";

export const ADMIN_2FA_AUDIENCE = "elloot-admin-2fa";
const CHALLENGE_TTL_SEC = 10 * 60;

type AdminChallengePayload = {
  typ: "admin_2fa_challenge";
  sub: string;
  email: string;
  jti: string;
};

const memoryUsed = new Map<string, number>();

function usedKey(jti: string) {
  return `elloot:admin:2fa:used:${jti}`;
}

async function markUsed(jti: string): Promise<boolean> {
  /** Returns true if this is the first use (consumed successfully). */
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

export function signAdminChallenge(user: { id: string; email: string }) {
  const jti = newTokenId();
  return jwt.sign(
    { typ: "admin_2fa_challenge", email: user.email },
    env.ADMIN_JWT_SECRET,
    {
      subject: user.id,
      jwtid: jti,
      expiresIn: "10m",
      audience: ADMIN_2FA_AUDIENCE,
      algorithm: "HS256",
    },
  );
}

/**
 * Verify signature/audience and burn the challenge (one-time).
 */
export async function verifyAndConsumeAdminChallenge(
  token: string,
): Promise<AdminChallengePayload> {
  let payload: jwt.JwtPayload & { typ?: string; email?: string };
  try {
    payload = jwt.verify(token, env.ADMIN_JWT_SECRET, {
      algorithms: ["HS256"],
      audience: ADMIN_2FA_AUDIENCE,
    }) as jwt.JwtPayload & { typ?: string; email?: string };
  } catch {
    throw new AppError(
      401,
      "Desafio 2FA inválido ou expirado",
      "2FA_CHALLENGE_INVALID",
    );
  }

  if (
    payload.typ !== "admin_2fa_challenge" ||
    !payload.sub ||
    !payload.email ||
    !payload.jti
  ) {
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
    typ: "admin_2fa_challenge",
    sub: payload.sub,
    email: payload.email,
    jti: payload.jti,
  };
}
