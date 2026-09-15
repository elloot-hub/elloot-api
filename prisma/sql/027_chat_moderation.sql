-- Chat moderation: admin status + internal notes + RLS insert for admin.

DO $$ BEGIN
  CREATE TYPE "ConversationModerationStatus" AS ENUM ('OPEN', 'REPORTED', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "moderationStatus" "ConversationModerationStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN IF NOT EXISTS "reportReason" TEXT,
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "adminLastReadAt" TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS "internal" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS conversations_moderation_status_idx
  ON conversations ("moderationStatus");

DROP POLICY IF EXISTS messages_insert ON messages;
CREATE POLICY messages_insert ON messages FOR INSERT
  WITH CHECK (
    app_is_service()
    OR app_is_admin()
    OR (
      "senderId" = app_current_user_id()
      AND EXISTS (
        SELECT 1
        FROM conversations c
        JOIN orders o ON o.id = c."orderId"
        WHERE c.id = "conversationId"
          AND (
            o."buyerId" = app_current_user_id()
            OR o."sellerId" = app_current_user_id()
          )
      )
    )
  );
