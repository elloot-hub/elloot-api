-- Allow participants (and service) to mark messages as read.

DROP POLICY IF EXISTS messages_update ON messages;
CREATE POLICY messages_update ON messages FOR UPDATE
  USING (
    app_is_service() OR app_is_admin() OR EXISTS (
      SELECT 1 FROM conversations c
      JOIN orders o ON o.id = c."orderId"
      WHERE c.id = "conversationId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  )
  WITH CHECK (
    app_is_service() OR app_is_admin() OR EXISTS (
      SELECT 1 FROM conversations c
      JOIN orders o ON o.id = c."orderId"
      WHERE c.id = "conversationId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );
