import { connectRedis, redis } from "../../databases";
import { env } from "../../config/env";

const CACHE_KEY = "elloot:home:sections:v1";

type MemoryEntry = {
  payload: string;
  expiresAt: number;
};

let memory: MemoryEntry | null = null;

export function homeSectionsCacheTtlSec() {
  return Math.max(0, env.HOME_SECTIONS_CACHE_TTL_SEC);
}

export async function getHomeSectionsCache<T>(): Promise<T | null> {
  if (redis) {
    try {
      await connectRedis();
      const raw = await redis.get(CACHE_KEY);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      // fall through to memory
    }
  }

  if (memory && memory.expiresAt > Date.now()) {
    try {
      return JSON.parse(memory.payload) as T;
    } catch {
      memory = null;
    }
  } else if (memory) {
    memory = null;
  }

  return null;
}

export async function setHomeSectionsCache(value: unknown): Promise<void> {
  const ttl = homeSectionsCacheTtlSec();
  if (ttl <= 0) return;

  const payload = JSON.stringify(value);
  memory = {
    payload,
    expiresAt: Date.now() + ttl * 1000,
  };

  if (!redis) return;
  try {
    await connectRedis();
    await redis.set(CACHE_KEY, payload, "EX", ttl);
  } catch {
    // memory still holds the value
  }
}

export async function invalidateHomeSectionsCache(): Promise<void> {
  memory = null;
  if (!redis) return;
  try {
    await connectRedis();
    await redis.del(CACHE_KEY);
  } catch {
    // ignore
  }
}
