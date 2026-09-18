import { env } from "../../config/env";

/** `feeBps` override from listing reach plan; falls back to PLATFORM_FEE_BPS. */
export function calcFeeCents(amountCents: number, feeBps?: number | null) {
  const bps =
    feeBps != null && Number.isFinite(feeBps) && feeBps >= 0
      ? feeBps
      : env.PLATFORM_FEE_BPS;
  return Math.round((amountCents * bps) / 10_000);
}
