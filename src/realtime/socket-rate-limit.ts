/** Simple sliding-window rate limit for Socket.IO handlers (per user). */

type Bucket = {
  timestamps: number[];
};

const buckets = new Map<string, Bucket>();

export function consumeSocketRateLimit(input: {
  key: string;
  max: number;
  windowMs: number;
}): boolean {
  const now = Date.now();
  const cutoff = now - input.windowMs;
  let bucket = buckets.get(input.key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(input.key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
  if (bucket.timestamps.length >= input.max) {
    return false;
  }
  bucket.timestamps.push(now);
  return true;
}

/** Prune idle keys occasionally to avoid unbounded growth. */
export function pruneSocketRateLimits(maxIdleMs = 10 * 60 * 1000) {
  const cutoff = Date.now() - maxIdleMs;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}
