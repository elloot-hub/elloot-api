-- Sellers can read placements on their own listings (history / dashboard).

DROP POLICY IF EXISTS listing_placements_select ON listing_placements;
CREATE POLICY listing_placements_select ON listing_placements FOR SELECT
USING (
  (
    status = 'ACTIVE'
    AND ("startsAt" IS NULL OR "startsAt" <= now())
    AND ("endsAt" IS NULL OR "endsAt" > now())
  )
  OR current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
  OR EXISTS (
    SELECT 1 FROM listings l
    WHERE l.id = listing_placements."listingId"
      AND l."sellerId" = nullif(current_setting('app.user_id', true), '')
  )
);
