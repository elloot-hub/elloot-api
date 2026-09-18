-- Admin moderation for reviews: hide from public profiles + UPDATE policy.

ALTER TABLE "reviews"
  ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "reviews_hidden_createdAt_idx"
  ON "reviews"("hidden", "createdAt");

GRANT SELECT, INSERT ON TABLE reviews TO elloot_app;
GRANT UPDATE ("hidden") ON TABLE reviews TO elloot_app;

DROP POLICY IF EXISTS reviews_update ON reviews;
CREATE POLICY reviews_update ON reviews FOR UPDATE
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());
