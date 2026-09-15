-- Allow party members to read User rows that sent messages in their order chats.
-- Without this, admin (or other non-party) replies make Prisma fail with
-- "Field sender is required to return data, got null instead" under RLS.

DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users FOR SELECT
  USING (
    id = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
    OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l."sellerId" = users.id AND l.status = 'ACTIVE'
    )
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
        AND (o."buyerId" = users.id OR o."sellerId" = users.id)
    )
    OR EXISTS (
      SELECT 1
      FROM listing_questions q
      JOIN listings l ON l.id = q."listingId"
      WHERE q."askerId" = users.id
        AND q.moderated = false
        AND (
          l.status = 'ACTIVE'
          OR l."sellerId" = app_current_user_id()
          OR q."askerId" = app_current_user_id()
          OR app_is_admin()
          OR app_is_service()
        )
    )
    OR EXISTS (
      SELECT 1
      FROM reviews r
      JOIN listings l ON l.id = r."listingId"
      WHERE r."buyerId" = users.id
        AND (
          l.status = 'ACTIVE'
          OR l."sellerId" = app_current_user_id()
          OR r."buyerId" = app_current_user_id()
          OR app_is_admin()
          OR app_is_service()
        )
    )
    OR EXISTS (
      SELECT 1
      FROM messages m
      JOIN conversations c ON c.id = m."conversationId"
      JOIN orders o ON o.id = c."orderId"
      WHERE m."senderId" = users.id
        AND m.internal = false
        AND (
          o."buyerId" = app_current_user_id()
          OR o."sellerId" = app_current_user_id()
        )
    )
  );
