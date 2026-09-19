-- Allow admins/service to see soft-deleted media (trash) and complete UPDATE RETURNING.

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
