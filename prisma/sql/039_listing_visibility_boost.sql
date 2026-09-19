-- Catalog ranking: denormalized max priority from active visibility placements.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS "visibilityBoost" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS listings_status_reachPriority_createdAt_idx;
CREATE INDEX IF NOT EXISTS listings_status_visibilityBoost_reachPriority_createdAt_idx
  ON listings (status, "visibilityBoost", "reachPriority", "createdAt");
