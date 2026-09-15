-- Auth sessions (device / JWT tracking for settings UI).

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenJti" TEXT NOT NULL,
  "userAgent" TEXT,
  "ip" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "auth_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_tokenJti_key"
  ON "auth_sessions"("tokenJti");

CREATE INDEX IF NOT EXISTS "auth_sessions_userId_revokedAt_idx"
  ON "auth_sessions"("userId", "revokedAt");

ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_sessions" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_sessions" TO elloot_app;

DROP POLICY IF EXISTS auth_sessions_select ON "auth_sessions";
CREATE POLICY auth_sessions_select ON "auth_sessions" FOR SELECT
  USING (
    "userId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
  );

DROP POLICY IF EXISTS auth_sessions_insert ON "auth_sessions";
CREATE POLICY auth_sessions_insert ON "auth_sessions" FOR INSERT
  WITH CHECK (
    "userId" = app_current_user_id()
    OR app_is_service()
    OR app_is_admin()
  );

DROP POLICY IF EXISTS auth_sessions_update ON "auth_sessions";
CREATE POLICY auth_sessions_update ON "auth_sessions" FOR UPDATE
  USING (
    "userId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
  )
  WITH CHECK (
    "userId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
  );

DROP POLICY IF EXISTS auth_sessions_delete ON "auth_sessions";
CREATE POLICY auth_sessions_delete ON "auth_sessions" FOR DELETE
  USING (
    "userId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
  );
