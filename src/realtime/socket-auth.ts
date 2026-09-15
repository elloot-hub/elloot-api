import { env } from "../config/env";

function splitOrigins(raw: string) {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function adminCorsOrigins() {
  return splitOrigins(env.ADMIN_CORS_ORIGIN);
}

export function appCorsOrigins() {
  return splitOrigins(env.CORS_ORIGIN);
}

/**
 * Cookie `elloot_admin_at` e `elloot_at` compartilham host em localhost
 * (portas diferentes não isolam cookie). Sem este gate, o socket do app
 * autentica como admin e a presença fica no userId errado.
 */
export function shouldPreferAdminCookie(input: {
  origin: string | undefined;
  hasAdminCookie: boolean;
  hasUserCookie: boolean;
  /** handshake.auth.panel === "admin" — opcional, clientes futuros */
  authPanel?: string | null;
}): boolean {
  if (!input.hasAdminCookie) return false;
  if (input.authPanel === "admin") return true;

  const origin = input.origin?.trim() ?? "";
  if (!origin) {
    // Sem Origin: só admin cookie se não houver cookie de marketplace.
    return !input.hasUserCookie;
  }

  const adminOrigins = adminCorsOrigins();
  if (adminOrigins.includes(origin)) return true;

  const appOrigins = appCorsOrigins();
  if (appOrigins.includes(origin)) return false;

  // Origin desconhecida: não roubar a sessão do marketplace.
  return !input.hasUserCookie;
}

export function parseCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
