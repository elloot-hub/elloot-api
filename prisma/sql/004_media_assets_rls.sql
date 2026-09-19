-- Media CDN assets — Row Level Security
-- Run after prisma db push / migrate (table media_assets must exist)

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE media_assets TO elloot_app;

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_assets_select ON media_assets;
CREATE POLICY media_assets_select ON media_assets FOR SELECT
  USING (
    app_is_admin()
    OR app_is_service()
    OR (
      "deletedAt" IS NULL
      AND (
        visibility = 'PUBLIC'
        OR "ownerId" = app_current_user_id()
      )
    )
  );

DROP POLICY IF EXISTS media_assets_insert ON media_assets;
CREATE POLICY media_assets_insert ON media_assets FOR INSERT
  WITH CHECK (
    app_is_service()
    OR (
      "ownerId" = app_current_user_id()
      AND app_current_user_id() <> ''
    )
  );

DROP POLICY IF EXISTS media_assets_update ON media_assets;
CREATE POLICY media_assets_update ON media_assets FOR UPDATE
  USING (
    app_is_service()
    OR app_is_admin()
    OR "ownerId" = app_current_user_id()
  )
  WITH CHECK (
    app_is_service()
    OR app_is_admin()
    OR "ownerId" = app_current_user_id()
  );

DROP POLICY IF EXISTS media_assets_delete ON media_assets;
CREATE POLICY media_assets_delete ON media_assets FOR DELETE
  USING (
    app_is_service()
    OR app_is_admin()
    OR "ownerId" = app_current_user_id()
  );
