-- Public codes for listings, disputes and payouts (LST/DSP/PAY-YYMM-XXXXXX).

ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "code" TEXT;

UPDATE "listings"
SET "code" = 'LST-' || TO_CHAR("createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5("id"), 1, 6))
WHERE "code" IS NULL;

UPDATE "listings" l
SET "code" = 'LST-' || TO_CHAR(l."createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5(l."id" || l."id"), 1, 6))
WHERE l."code" IN (
  SELECT "code" FROM "listings" GROUP BY "code" HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "listings_code_key" ON "listings"("code");
ALTER TABLE "listings" ALTER COLUMN "code" SET NOT NULL;

ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "code" TEXT;

UPDATE "disputes"
SET "code" = 'DSP-' || TO_CHAR("createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5("id"), 1, 6))
WHERE "code" IS NULL;

UPDATE "disputes" d
SET "code" = 'DSP-' || TO_CHAR(d."createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5(d."id" || d."id"), 1, 6))
WHERE d."code" IN (
  SELECT "code" FROM "disputes" GROUP BY "code" HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "disputes_code_key" ON "disputes"("code");
ALTER TABLE "disputes" ALTER COLUMN "code" SET NOT NULL;

ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "code" TEXT;

UPDATE "payouts"
SET "code" = 'PAY-' || TO_CHAR("createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5("id"), 1, 6))
WHERE "code" IS NULL;

UPDATE "payouts" p
SET "code" = 'PAY-' || TO_CHAR(p."createdAt", 'YYMM') || '-' ||
  UPPER(SUBSTR(MD5(p."id" || p."id"), 1, 6))
WHERE p."code" IN (
  SELECT "code" FROM "payouts" GROUP BY "code" HAVING COUNT(*) > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "payouts_code_key" ON "payouts"("code");
ALTER TABLE "payouts" ALTER COLUMN "code" SET NOT NULL;
