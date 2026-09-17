-- Visibility products + home sections (admin-configurable homepage).
-- Grants for elloot_app; public read policies come in a later phase.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE visibility_products TO elloot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE home_sections TO elloot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE listing_placements TO elloot_app;
