import type { Prisma } from "@prisma/client";
import { AppError } from "./errors";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
export const BIO_MAX = 280;
/** Days a user must wait between display-name changes. */
export const NAME_CHANGE_COOLDOWN_DAYS = 30;

const USERNAME_RE = /^[a-z][a-z0-9_]{2,23}$/;

const RESERVED = new Set([
  "admin",
  "api",
  "auth",
  "cart",
  "dashboard",
  "elloot",
  "help",
  "home",
  "login",
  "logout",
  "market",
  "me",
  "messages",
  "null",
  "perfil",
  "profile",
  "register",
  "root",
  "sell",
  "settings",
  "support",
  "system",
  "undefined",
  "vendedor",
  "vendedores",
  "wallet",
]);

type Tx = Prisma.TransactionClient;

/** First word of a display name ("Walison Amorim" → "Walison"). */
export function firstNameFromDisplayName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** Normalize raw input into a candidate username (lowercase, stripped). */
export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, USERNAME_MAX);
}

export function isValidUsername(username: string): boolean {
  return (
    USERNAME_RE.test(username) &&
    !RESERVED.has(username) &&
    username.length >= USERNAME_MIN &&
    username.length <= USERNAME_MAX
  );
}

function seedFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  let base = normalizeUsername(local);
  if (!base || !/^[a-z]/.test(base)) {
    base = `u${base || "ser"}`.slice(0, USERNAME_MAX);
  }
  if (base.length < USERNAME_MIN) {
    base = `${base}user`.slice(0, USERNAME_MAX);
  }
  if (!/^[a-z]/.test(base)) base = `u${base}`.slice(0, USERNAME_MAX);
  return base.slice(0, USERNAME_MAX);
}

/** Username seed from display name — first name only. */
function seedFromName(name: string | null | undefined, email: string): string {
  if (name?.trim()) {
    const first = firstNameFromDisplayName(name);
    let base = normalizeUsername(first);
    if (base && /^[a-z]/.test(base)) {
      if (base.length < USERNAME_MIN) {
        base = `${base}user`.slice(0, USERNAME_MAX);
      }
      if (isValidUsername(base) || (base.length >= USERNAME_MIN && /^[a-z]/.test(base))) {
        return base.slice(0, USERNAME_MAX);
      }
    }
  }
  return seedFromEmail(email);
}

/** Allocate a unique username from first name (or email fallback). */
export async function allocateUsername(
  tx: Tx,
  opts: { email: string; name?: string | null; excludeUserId?: string },
): Promise<string> {
  const base = seedFromName(opts.name, opts.email);

  // Username uniqueness must see ALL users. Under RLS a normal actor only
  // sees a subset, so findUnique would miss taken handles and the later
  // UPDATE hits P2002. Temporarily elevate for the existence checks.
  const settingRows = await tx.$queryRaw<Array<{ v: string | null }>>`
    SELECT nullif(current_setting('app.is_service', true), '') AS v
  `;
  const wasService = settingRows[0]?.v === "on";
  if (!wasService) {
    await tx.$executeRaw`SELECT set_config('app.is_service', 'on', true)`;
  }

  try {
    for (let i = 0; i < 40; i += 1) {
      const suffix = i === 0 ? "" : String(i + 1);
      const candidate = `${base.slice(0, USERNAME_MAX - suffix.length)}${suffix}`;
      if (!isValidUsername(candidate)) continue;

      const existing = await tx.user.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (!existing || existing.id === opts.excludeUserId) {
        return candidate;
      }
    }

    const fallback = `user${Date.now().toString(36)}`.slice(0, USERNAME_MAX);
    return fallback;
  } finally {
    if (!wasService) {
      await tx.$executeRaw`SELECT set_config('app.is_service', 'off', true)`;
    }
  }
}

/** Ensure user has a username; returns the username. */
export async function ensureUserUsername(
  tx: Tx,
  user: { id: string; email: string; name: string | null; username: string | null },
): Promise<string> {
  if (user.username && isValidUsername(user.username)) {
    return user.username;
  }
  const username = await allocateUsername(tx, {
    email: user.email,
    name: user.name,
    excludeUserId: user.id,
  });
  await tx.user.update({
    where: { id: user.id },
    data: { username },
  });
  return username;
}

export function nameChangeAvailableAt(nameChangedAt: Date | null | undefined): Date | null {
  if (!nameChangedAt) return null;
  const available = new Date(nameChangedAt);
  available.setUTCDate(available.getUTCDate() + NAME_CHANGE_COOLDOWN_DAYS);
  return available;
}

export function assertNameChangeAllowed(nameChangedAt: Date | null | undefined) {
  const availableAt = nameChangeAvailableAt(nameChangedAt);
  if (!availableAt) return;
  const now = Date.now();
  if (now >= availableAt.getTime()) return;

  const daysLeft = Math.max(
    1,
    Math.ceil((availableAt.getTime() - now) / (24 * 60 * 60 * 1000)),
  );
  throw new AppError(
    429,
    `Você só pode alterar o nome a cada ${NAME_CHANGE_COOLDOWN_DAYS} dias. Tente de novo em ${daysLeft} dia${daysLeft === 1 ? "" : "s"}.`,
    "NAME_CHANGE_COOLDOWN",
  );
}

export function namesAreEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (a?.trim() ?? "") === (b?.trim() ?? "");
}
