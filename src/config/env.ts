import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { loadEnvironment } from "./load-env";
import { resolveSslCertPath, withPostgresSsl } from "./ssl";

loadEnvironment();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  APP_URL: z.string().default("http://localhost:3333"),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CERT_PATH: z.string().optional(),
  DATABASE_SSL_CERT: z.string().optional(),
  DATABASE_SSL_P12_PASSWORD: z.string().optional().default("elloot"),
  REDIS_URL: z.string().optional(),
  REDIS_SSL_CERT_PATH: z.string().optional(),
  REDIS_SSL_CERT: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("12h"),
  ADMIN_JWT_SECRET: z.string().min(32),
  ADMIN_JWT_EXPIRES_IN: z.string().default("2h"),
  ADMIN_CORS_ORIGIN: z.string().default("http://localhost:3001"),
  ADMIN_FRONTEND_URL: z.string().default("http://localhost:3001"),
  /** Comma-separated IPs. Empty = allow all (dev only). Required in production. */
  ADMIN_IP_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((ip) => ip.trim())
            .filter(Boolean)
        : [],
    ),
  /**
   * Express trust proxy hops. Default 1 (e.g. Square Cloud / one reverse proxy).
   * Set 0 only when the API is exposed without a proxy (local direct).
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(1000),
  ESCROW_AUTO_RELEASE_HOURS: z.coerce.number().int().positive().default(48),
  PAYMENT_PROVIDER: z.enum(["sandbox", "efi"]).default("sandbox"),
  EFI_CLIENT_ID: z.string().optional(),
  EFI_CLIENT_SECRET: z.string().optional(),
  EFI_CERT_PATH: z.string().optional(),
  EFI_CERT_PASSPHRASE: z.string().optional().default(""),
  /** Optional PEM key when certificate is a .pem (not .p12). */
  EFI_PEM_KEY_PATH: z.string().optional(),
  EFI_PIX_KEY: z.string().optional(),
  EFI_SANDBOX: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * When true, POST /api/payments/sandbox/confirm is allowed.
   * Defaults to false in production, true otherwise.
   */
  ALLOW_SANDBOX_PAYMENTS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : v === "true",
    ),
  /** Required for POST /api/payments/sandbox/webhook. Empty = webhook disabled. */
  SANDBOX_WEBHOOK_SECRET: z.string().optional(),
  CHECKOUT_RESERVE_SECONDS: z.coerce.number().int().positive().default(900),
  JOB_SECRET: z.string().optional(),
  JOB_POLL_MS: z.coerce.number().int().min(0).default(60_000),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),

  /** local = disk under MEDIA_LOCAL_DIR; s3 = S3/R2 compatible */
  MEDIA_DRIVER: z.enum(["local", "s3"]).default("local"),
  MEDIA_LOCAL_DIR: z.string().default("./storage/media"),
  /** Public base for CDN URLs (R2 custom domain / CloudFront). Empty = API serves content. */
  MEDIA_PUBLIC_BASE_URL: z.string().optional(),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  MEDIA_SIGNING_SECRET: z.string().optional(),
  MEDIA_SIGN_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  MEDIA_S3_ENDPOINT: z.string().optional(),
  MEDIA_S3_REGION: z.string().default("auto"),
  MEDIA_S3_BUCKET: z.string().optional(),
  MEDIA_S3_ACCESS_KEY_ID: z.string().optional(),
  MEDIA_S3_SECRET_ACCESS_KEY: z.string().optional(),
  MEDIA_S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /** Web Push (optional). Generate: npx web-push generate-vapid-keys */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** mailto: or https: contact for push service */
  VAPID_SUBJECT: z.string().optional(),

  /** SMTP — password reset / transactional email. Empty = disabled (dev logs link). */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** From header, e.g. "Elloot <noreply@elloot.com.br>" */
  SMTP_FROM: z.string().optional(),
  /** Log reset URLs even when SMTP works (dev only recommended). */
  PASSWORD_RESET_LOG_LINKS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const data = parsed.data;

const WEAK_JWT_SECRETS = new Set([
  "change-me-in-production-use-long-random-string",
  "changeme",
  "secret",
  "jwt-secret",
]);

if (
  WEAK_JWT_SECRETS.has(data.JWT_SECRET) ||
  data.JWT_SECRET.length < 32 ||
  data.JWT_SECRET.startsWith("replace-with") ||
  data.JWT_SECRET.startsWith("change-me")
) {
  console.error(
    "JWT_SECRET is missing, too short (<32), or uses a known placeholder. Generate a long random secret.",
  );
  process.exit(1);
}

if (
  WEAK_JWT_SECRETS.has(data.ADMIN_JWT_SECRET) ||
  data.ADMIN_JWT_SECRET.length < 32 ||
  data.ADMIN_JWT_SECRET.startsWith("replace-with") ||
  data.ADMIN_JWT_SECRET.startsWith("change-me") ||
  data.ADMIN_JWT_SECRET === data.JWT_SECRET
) {
  console.error(
    "ADMIN_JWT_SECRET must be a distinct secret (>=32 chars), not equal to JWT_SECRET.",
  );
  process.exit(1);
}

if (data.NODE_ENV === "production" && data.ADMIN_IP_ALLOWLIST.length === 0) {
  console.error(
    "ADMIN_IP_ALLOWLIST is required in production (comma-separated IPs of offices/VPN). Refusing to start with an open admin panel.",
  );
  process.exit(1);
}

if (
  data.NODE_ENV === "production" &&
  data.PAYMENT_PROVIDER === "sandbox"
) {
  console.error(
    "PAYMENT_PROVIDER=sandbox is not allowed in production. Set PAYMENT_PROVIDER=efi.",
  );
  process.exit(1);
}

if (
  data.NODE_ENV === "production" &&
  data.PAYMENT_PROVIDER === "efi" &&
  data.EFI_SANDBOX
) {
  console.warn(
    "[go-live] EFI_SANDBOX=true while NODE_ENV=production — PIX will hit Efí sandbox, not live money.",
  );
}

if (
  data.MEDIA_SIGNING_SECRET &&
  (WEAK_JWT_SECRETS.has(data.MEDIA_SIGNING_SECRET) ||
    data.MEDIA_SIGNING_SECRET.length < 32)
) {
  console.error(
    "MEDIA_SIGNING_SECRET is too weak. Use a long random secret distinct from JWT_SECRET.",
  );
  process.exit(1);
}

const allowSandboxPayments =
  data.ALLOW_SANDBOX_PAYMENTS ?? data.NODE_ENV !== "production";

if (data.NODE_ENV === "production" && allowSandboxPayments) {
  console.error(
    "ALLOW_SANDBOX_PAYMENTS cannot be true in production. Omit it or set false.",
  );
  process.exit(1);
}

const postgresCertPath = resolveSslCertPath({
  pathEnv: data.DATABASE_SSL_CERT_PATH,
  contentEnv: data.DATABASE_SSL_CERT,
  filename: "postgres.pem",
});

const redisCertPath = resolveSslCertPath({
  pathEnv: data.REDIS_SSL_CERT_PATH,
  contentEnv: data.REDIS_SSL_CERT,
  filename: "redis.pem",
});

if (postgresCertPath) {
  process.env.DATABASE_URL = withPostgresSsl(
    data.DATABASE_URL,
    postgresCertPath,
    data.DATABASE_SSL_P12_PASSWORD,
  );
}

const s3Configured = Boolean(
  data.MEDIA_S3_BUCKET &&
    data.MEDIA_S3_ACCESS_KEY_ID &&
    data.MEDIA_S3_SECRET_ACCESS_KEY,
);

if (data.MEDIA_DRIVER === "s3" && !s3Configured) {
  console.error(
    "MEDIA_DRIVER=s3 requires MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, MEDIA_S3_SECRET_ACCESS_KEY",
  );
  process.exit(1);
}

if (data.PAYMENT_PROVIDER === "efi") {
  const missing: string[] = [];
  if (!data.EFI_CLIENT_ID?.trim()) missing.push("EFI_CLIENT_ID");
  if (!data.EFI_CLIENT_SECRET?.trim()) missing.push("EFI_CLIENT_SECRET");
  if (!data.EFI_CERT_PATH?.trim()) missing.push("EFI_CERT_PATH");
  if (!data.EFI_PIX_KEY?.trim()) missing.push("EFI_PIX_KEY");
  if (missing.length) {
    console.error(
      `PAYMENT_PROVIDER=efi requires: ${missing.join(", ")}`,
    );
    process.exit(1);
  }
  const certPath = resolve(process.cwd(), data.EFI_CERT_PATH!);
  if (!existsSync(certPath)) {
    console.error(`EFI certificate not found: ${certPath}`);
    process.exit(1);
  }
}

export const env = {
  ...data,
  DATABASE_URL: process.env.DATABASE_URL!,
  postgresCertPath,
  redisCertPath,
  googleEnabled: Boolean(data.GOOGLE_CLIENT_ID && data.GOOGLE_CLIENT_SECRET),
  discordEnabled: Boolean(data.DISCORD_CLIENT_ID && data.DISCORD_CLIENT_SECRET),
  mediaSigningSecret: data.MEDIA_SIGNING_SECRET || data.JWT_SECRET,
  s3Configured,
  allowSandboxPayments,
  webPushEnabled: Boolean(
    data.VAPID_PUBLIC_KEY?.trim() &&
      data.VAPID_PRIVATE_KEY?.trim() &&
      data.VAPID_SUBJECT?.trim(),
  ),
  smtpEnabled: Boolean(
    data.SMTP_HOST?.trim() &&
      data.SMTP_USER?.trim() &&
      data.SMTP_PASS?.trim() &&
      data.SMTP_FROM?.trim(),
  ),
  smtpSecure:
    data.SMTP_SECURE ??
    (data.SMTP_PORT === 465),
};
