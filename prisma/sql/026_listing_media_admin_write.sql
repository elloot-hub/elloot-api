-- Admin precisa gravar mídia ao aprovar edições de anúncio na moderação.
-- A policy original só permitia o vendedor dono ou o papel de serviço, então
-- POST /api/admin/listings/moderation/:id/approve quebrava com erro 42501.

DROP POLICY IF EXISTS listing_media_write ON listing_media;
CREATE POLICY listing_media_write ON listing_media FOR ALL
  USING (
    app_is_service()
    OR app_is_admin()
    OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = "listingId" AND l."sellerId" = app_current_user_id()
    )
  )
  WITH CHECK (
    app_is_service()
    OR app_is_admin()
    OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = "listingId" AND l."sellerId" = app_current_user_id()
    )
  );
