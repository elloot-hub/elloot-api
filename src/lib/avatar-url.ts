import { env } from "../config/env";
import { AppError } from "./errors";

const OAUTH_AVATAR_HOSTS = new Set([
  "lh3.googleusercontent.com",
  "cdn.discordapp.com",
]);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function allowedOrigins(): Set<string> {
  const set = new Set<string>();
  const app = originOf(env.APP_URL);
  if (app) set.add(app);
  const media = env.MEDIA_PUBLIC_BASE_URL
    ? originOf(env.MEDIA_PUBLIC_BASE_URL)
    : null;
  if (media) set.add(media);
  return set;
}

/**
 * Avatars may be cleared (null), served from our media API/CDN,
 * or kept from Google/Discord OAuth hosts.
 */
export function assertAllowedAvatarUrl(url: string | null): string | null {
  if (url === null) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(400, "URL de avatar inválida", "INVALID_AVATAR_URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError(400, "URL de avatar inválida", "INVALID_AVATAR_URL");
  }

  const host = parsed.hostname.toLowerCase();
  if (OAUTH_AVATAR_HOSTS.has(host)) {
    return url;
  }

  const origins = allowedOrigins();
  if (origins.has(parsed.origin)) {
    // Prefer API media content paths when hosted on APP_URL.
    if (originOf(env.APP_URL) === parsed.origin) {
      // Accept MED-YYMM-XXXXXX (preferred) or legacy cuid in the path.
      if (
        !/^\/api\/media\/(MED-\d{4}-[A-Z0-9]{6}|[a-z0-9]{20,})\/content\/?$/i.test(
          parsed.pathname,
        )
      ) {
        throw new AppError(
          400,
          "Use um arquivo de mídia da plataforma como avatar.",
          "INVALID_AVATAR_URL",
        );
      }
    }
    return url;
  }

  throw new AppError(
    400,
    "Avatar deve ser um arquivo da plataforma ou do login social.",
    "INVALID_AVATAR_URL",
  );
}
