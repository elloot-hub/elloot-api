import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";

export type StoredObject = {
  key: string;
  sizeBytes: number;
  mimeType: string;
};

function s3Client() {
  if (!env.s3Configured) {
    throw new AppError(500, "S3 media driver is not configured", "MEDIA_S3_CONFIG");
  }
  return new S3Client({
    region: env.MEDIA_S3_REGION,
    endpoint: env.MEDIA_S3_ENDPOINT || undefined,
    forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY!,
    },
  });
}

function absoluteLocalPath(key: string) {
  const root = path.resolve(env.MEDIA_LOCAL_DIR);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new AppError(400, "Invalid media key", "MEDIA_PATH_INVALID");
  }
  return full;
}

export function sha256Hex(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function putObject(input: {
  key: string;
  body: Buffer;
  mimeType: string;
  overwrite?: boolean;
}): Promise<StoredObject> {
  if (env.MEDIA_DRIVER === "local") {
    const full = absoluteLocalPath(input.key);
    await mkdir(path.dirname(full), { recursive: true });
    if (input.overwrite) {
      await writeFile(full, input.body);
    } else {
      await writeFile(full, input.body, { flag: "wx" }).catch(
        async (err: NodeJS.ErrnoException) => {
          if (err.code === "EEXIST") {
            throw new AppError(409, "Object key already exists", "MEDIA_KEY_EXISTS");
          }
          throw err;
        },
      );
    }
    return {
      key: input.key,
      sizeBytes: input.body.byteLength,
      mimeType: input.mimeType,
    };
  }

  const client = s3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.MEDIA_S3_BUCKET!,
      Key: input.key,
      Body: input.body,
      ContentType: input.mimeType,
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: "inline",
    }),
  );
  return {
    key: input.key,
    sizeBytes: input.body.byteLength,
    mimeType: input.mimeType,
  };
}

export async function getObjectBuffer(key: string): Promise<{
  body: Buffer;
  mimeType?: string;
}> {
  if (env.MEDIA_DRIVER === "local") {
    const body = await readFile(absoluteLocalPath(key));
    return { body };
  }

  const client = s3Client();
  const res = await client.send(
    new GetObjectCommand({
      Bucket: env.MEDIA_S3_BUCKET!,
      Key: key,
    }),
  );
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) {
    throw new AppError(404, "Media object not found", "MEDIA_NOT_FOUND");
  }
  return {
    body: Buffer.from(bytes),
    mimeType: res.ContentType,
  };
}

export async function deleteObject(key: string) {
  if (env.MEDIA_DRIVER === "local") {
    await unlink(absoluteLocalPath(key)).catch(() => undefined);
    return;
  }
  const client = s3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.MEDIA_S3_BUCKET!,
      Key: key,
    }),
  );
}

export async function objectExists(key: string) {
  if (env.MEDIA_DRIVER === "local") {
    try {
      await readFile(absoluteLocalPath(key));
      return true;
    } catch {
      return false;
    }
  }
  const client = s3Client();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: env.MEDIA_S3_BUCKET!,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function createPresignedUpload(input: {
  key: string;
  mimeType: string;
  expiresIn?: number;
}) {
  if (env.MEDIA_DRIVER !== "s3") {
    throw new AppError(
      400,
      "Presigned upload is only available with MEDIA_DRIVER=s3",
      "MEDIA_PRESIGN_UNSUPPORTED",
    );
  }
  const client = s3Client();
  const command = new PutObjectCommand({
    Bucket: env.MEDIA_S3_BUCKET!,
    Key: input.key,
    ContentType: input.mimeType,
    CacheControl: "public, max-age=31536000, immutable",
  });
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: input.expiresIn ?? env.MEDIA_SIGN_TTL_SECONDS,
  });
  return { uploadUrl, headers: { "Content-Type": input.mimeType } };
}

export function publicUrlForAsset(asset: { code: string; key: string }) {
  const base = env.MEDIA_PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (base) return `${base}/${asset.key}`;
  return `${env.APP_URL.replace(/\/$/, "")}/api/media/${asset.code}/content`;
}

/** HMAC signed URL for PRIVATE assets served by the API (uses public code). */
export function signContentAccess(
  publicRef: string,
  ttlSeconds = env.MEDIA_SIGN_TTL_SECONDS,
) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const nonce = randomBytes(8).toString("hex");
  const payload = `${publicRef}.${exp}.${nonce}`;
  const sig = createHmac("sha256", env.mediaSigningSecret)
    .update(payload)
    .digest("hex");
  return {
    url: `${env.APP_URL.replace(/\/$/, "")}/api/media/${encodeURIComponent(publicRef)}/content?exp=${exp}&nonce=${nonce}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyContentAccess(input: {
  publicRef: string;
  exp: string;
  nonce: string;
  sig: string;
}) {
  const exp = Number(input.exp);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }
  if (!/^[a-f0-9]{16}$/i.test(input.nonce) || !/^[a-f0-9]{64}$/i.test(input.sig)) {
    return false;
  }
  const payload = `${input.publicRef}.${input.exp}.${input.nonce}`;
  const expected = createHmac("sha256", env.mediaSigningSecret)
    .update(payload)
    .digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(input.sig, "utf8"),
    );
  } catch {
    return false;
  }
}
