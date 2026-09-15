import { createHash } from "node:crypto";
import { connectRedis, redis } from "../../databases";
import { adminJwtExpiresMs } from "../../lib/admin-auth-cookie";
import { newTokenId } from "../auth/token-revoke";

export { newTokenId };

const memoryRevoked = new Map<string, number>();

function revokeKey(jti: string) {
  return `elloot:admin:jwt:revoked:${jti}`;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function revokeAdminAccessToken(
  token: string,
  opts?: { jti?: string; expiresAtMs?: number },
) {
  const jti = opts?.jti ?? hashToken(token);
  const ttlMs = Math.max(
    1_000,
    (opts?.expiresAtMs ?? Date.now() + adminJwtExpiresMs()) - Date.now(),
  );
  const ttlSec = Math.ceil(ttlMs / 1000);

  if (redis) {
    try {
      await connectRedis();
      await redis.set(revokeKey(jti), "1", "EX", ttlSec);
      return;
    } catch {
      /* fall through */
    }
  }
  memoryRevoked.set(jti, Date.now() + ttlMs);
}

export async function isAdminAccessTokenRevoked(input: {
  jti?: string | null;
  token: string;
}): Promise<boolean> {
  const jti = input.jti || hashToken(input.token);
  if (redis) {
    try {
      await connectRedis();
      const hit = await redis.get(revokeKey(jti));
      if (hit) return true;
    } catch {
      /* fall through */
    }
  }
  const exp = memoryRevoked.get(jti);
  if (!exp) return false;
  if (exp < Date.now()) {
    memoryRevoked.delete(jti);
    return false;
  }
  return true;
}
