import { randomBytes } from "node:crypto";

/** Prefixos de referência pública: PREFIX-YYMM-XXXXXX */
export const PUBLIC_CODE_PREFIX = {
  ORD: "ORD",
  LST: "LST",
  DSP: "DSP",
  PAY: "PAY",
} as const;

export type PublicCodeKind = keyof typeof PUBLIC_CODE_PREFIX;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function publicCodePattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}-\\d{4}-[A-Z0-9]{6}$`);
}

export function isPublicCode(kind: PublicCodeKind, ref: string): boolean {
  return publicCodePattern(PUBLIC_CODE_PREFIX[kind]).test(ref);
}

export function codePrefix(kind: PublicCodeKind, date = new Date()): string {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${PUBLIC_CODE_PREFIX[kind]}-${yy}${mm}-`;
}

export function randomPublicCodeSuffix(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

export function generatePublicCode(
  kind: PublicCodeKind,
  date = new Date(),
): string {
  return codePrefix(kind, date) + randomPublicCodeSuffix();
}

/** @deprecated Use isPublicCode("ORD", ref) */
export const ORDER_CODE_RE = publicCodePattern(PUBLIC_CODE_PREFIX.ORD);

/** @deprecated Use isPublicCode("ORD", ref) */
export function isOrderCode(ref: string): boolean {
  return isPublicCode("ORD", ref);
}

/** @deprecated Use generatePublicCode("ORD") */
export function generateOrderCode(date = new Date()): string {
  return generatePublicCode("ORD", date);
}

export function isListingCode(ref: string): boolean {
  return isPublicCode("LST", ref);
}

export function generateListingCode(date = new Date()): string {
  return generatePublicCode("LST", date);
}

export function isDisputeCode(ref: string): boolean {
  return isPublicCode("DSP", ref);
}

export function generateDisputeCode(date = new Date()): string {
  return generatePublicCode("DSP", date);
}

export function isPayoutCode(ref: string): boolean {
  return isPublicCode("PAY", ref);
}

export function generatePayoutCode(date = new Date()): string {
  return generatePublicCode("PAY", date);
}
