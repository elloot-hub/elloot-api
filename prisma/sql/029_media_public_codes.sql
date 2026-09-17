-- Public opaque codes for media assets (MED-YYMM-XXXXXX).
-- Replaces cuid in public /api/media/.../content URLs.

ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "code" TEXT;

UPDATE "media_assets"
SET "code" = 'MED-' || TO_CHAR("createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5("id"), 1, 6))
WHERE "code" IS NULL;

-- Resolve rare collisions
UPDATE "media_assets" m
SET "code" = 'MED-' || TO_CHAR(m."createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5(m."id" || m."id"), 1, 6))
WHERE m."code" IN (
  SELECT "code" FROM "media_assets" GROUP BY "code" HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_code_key" ON "media_assets"("code");
ALTER TABLE "media_assets" ALTER COLUMN "code" SET NOT NULL;

-- Rewrite stored public URLs that still embed the cuid.
UPDATE "media_assets" m
SET "url" = REGEXP_REPLACE(
  m."url",
  '/api/media/' || m."id" || '/content',
  '/api/media/' || m."code" || '/content'
)
WHERE m."url" LIKE '%/api/media/' || m."id" || '/content%';

UPDATE "listing_media" lm
SET "url" = REGEXP_REPLACE(
  lm."url",
  '/api/media/' || m."id" || '/content',
  '/api/media/' || m."code" || '/content'
)
FROM "media_assets" m
WHERE lm."url" LIKE '%/api/media/' || m."id" || '/content%';

UPDATE "users" u
SET "avatarUrl" = REGEXP_REPLACE(
  u."avatarUrl",
  '/api/media/' || m."id" || '/content',
  '/api/media/' || m."code" || '/content'
)
FROM "media_assets" m
WHERE u."avatarUrl" IS NOT NULL
  AND u."avatarUrl" LIKE '%/api/media/' || m."id" || '/content%';

UPDATE "categories" c
SET "imageUrl" = REGEXP_REPLACE(
  c."imageUrl",
  '/api/media/' || m."id" || '/content',
  '/api/media/' || m."code" || '/content'
)
FROM "media_assets" m
WHERE c."imageUrl" IS NOT NULL
  AND c."imageUrl" LIKE '%/api/media/' || m."id" || '/content%';

UPDATE "categories" c
SET "iconUrl" = REGEXP_REPLACE(
  c."iconUrl",
  '/api/media/' || m."id" || '/content',
  '/api/media/' || m."code" || '/content'
)
FROM "media_assets" m
WHERE c."iconUrl" IS NOT NULL
  AND c."iconUrl" LIKE '%/api/media/' || m."id" || '/content%';
