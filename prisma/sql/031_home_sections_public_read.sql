-- Public read for homepage sections + visibility (catalog-style).
-- Admin / service retain full write access.

ALTER TABLE home_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_sections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS home_sections_select ON home_sections;
CREATE POLICY home_sections_select ON home_sections FOR SELECT
USING (
  active = true
  OR current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
);

DROP POLICY IF EXISTS home_sections_write ON home_sections;
CREATE POLICY home_sections_write ON home_sections FOR ALL
USING (
  current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
)
WITH CHECK (
  current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
);

ALTER TABLE visibility_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE visibility_products FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS visibility_products_select ON visibility_products;
CREATE POLICY visibility_products_select ON visibility_products FOR SELECT
USING (
  active = true
  OR current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
);

DROP POLICY IF EXISTS visibility_products_write ON visibility_products;
CREATE POLICY visibility_products_write ON visibility_products FOR ALL
USING (
  current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
)
WITH CHECK (
  current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
);

ALTER TABLE listing_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_placements FORCE ROW LEVEL SECURITY;

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
);

DROP POLICY IF EXISTS listing_placements_write ON listing_placements;
CREATE POLICY listing_placements_write ON listing_placements FOR ALL
USING (
  current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
)
WITH CHECK (
  current_setting('app.user_role', true) = 'ADMIN'
  OR current_setting('app.is_service', true) = 'on'
);
