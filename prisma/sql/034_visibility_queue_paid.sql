-- Phase D: queue + paid amount on placements.

ALTER TABLE visibility_products
  ADD COLUMN IF NOT EXISTS "queueEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE listing_placements
  ADD COLUMN IF NOT EXISTS "paidCents" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS listing_placements_status_created_idx
  ON listing_placements (status, "createdAt");
