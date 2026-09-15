-- Public order codes (ORD-YYMM-XXXXXX) for URLs and support.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "code" TEXT;

UPDATE "orders"
SET "code" = 'ORD-' || TO_CHAR("createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5("id"), 1, 6))
WHERE "code" IS NULL;

-- Resolve rare MD5 collisions with a second pass.
UPDATE "orders" o
SET "code" = 'ORD-' || TO_CHAR(o."createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5(o."id" || o."id"), 1, 6))
WHERE o."code" IN (
  SELECT "code" FROM "orders" GROUP BY "code" HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "orders_code_key" ON "orders"("code");

ALTER TABLE "orders" ALTER COLUMN "code" SET NOT NULL;
