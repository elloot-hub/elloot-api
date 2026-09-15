import type {
  ClientRateLimitInfo,
  IncrementResponse,
  Options,
  Store,
} from "express-rate-limit";
import { connectRedis, redis } from "../databases";

type MemoryHit = { count: number; resetTime: number };

/**
 * Redis-backed store for express-rate-limit, with in-memory fallback when
 * Redis is disabled or temporarily unreachable (dev / single-node).
 */
export class HybridRateLimitStore implements Store {
  prefix: string;
  windowMs = 60_000;
  private memory = new Map<string, MemoryHit>();

  constructor(prefix: string) {
    this.prefix = prefix.endsWith(":") ? prefix : `${prefix}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private redisKey(key: string) {
    return `elloot:rl:${this.prefix}${key}`;
  }

  private pruneMemory() {
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.resetTime <= now) this.memory.delete(k);
    }
  }

  private memoryIncrement(key: string): IncrementResponse {
    this.pruneMemory();
    const now = Date.now();
    const existing = this.memory.get(key);
    if (!existing || existing.resetTime <= now) {
      const resetTime = now + this.windowMs;
      this.memory.set(key, { count: 1, resetTime });
      return { totalHits: 1, resetTime: new Date(resetTime) };
    }
    existing.count += 1;
    return {
      totalHits: existing.count,
      resetTime: new Date(existing.resetTime),
    };
  }

  private memoryDecrement(key: string) {
    const hit = this.memory.get(key);
    if (!hit) return;
    hit.count = Math.max(0, hit.count - 1);
  }

  private memoryReset(key: string) {
    this.memory.delete(key);
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (redis) {
      try {
        await connectRedis();
        const rkey = this.redisKey(key);
        const count = await redis.incr(rkey);
        if (count === 1) {
          await redis.pexpire(rkey, this.windowMs);
        }
        const pttl = await redis.pttl(rkey);
        const resetTime = new Date(
          Date.now() + (pttl > 0 ? pttl : this.windowMs),
        );
        return { totalHits: count, resetTime };
      } catch {
        /* fall through to memory */
      }
    }
    return this.memoryIncrement(key);
  }

  async decrement(key: string): Promise<void> {
    if (redis) {
      try {
        await connectRedis();
        const rkey = this.redisKey(key);
        const n = await redis.decr(rkey);
        if (n < 0) await redis.set(rkey, "0", "PX", this.windowMs);
        return;
      } catch {
        /* fall through */
      }
    }
    this.memoryDecrement(key);
  }

  async resetKey(key: string): Promise<void> {
    if (redis) {
      try {
        await connectRedis();
        await redis.del(this.redisKey(key));
        return;
      } catch {
        /* fall through */
      }
    }
    this.memoryReset(key);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    if (redis) {
      try {
        await connectRedis();
        const rkey = this.redisKey(key);
        const raw = await redis.get(rkey);
        if (raw == null) return undefined;
        const pttl = await redis.pttl(rkey);
        return {
          totalHits: Number(raw) || 0,
          resetTime: new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs)),
        };
      } catch {
        /* fall through */
      }
    }
    this.pruneMemory();
    const hit = this.memory.get(key);
    if (!hit) return undefined;
    return {
      totalHits: hit.count,
      resetTime: new Date(hit.resetTime),
    };
  }
}
