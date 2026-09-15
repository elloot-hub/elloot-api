-- Elloot security layer (Prisma camelCase columns)
-- Apply as privileged DB user. Runtime uses SET LOCAL ROLE elloot_app.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'elloot_app') THEN
    -- Password MUST be set out-of-band (never commit secrets):
    --   ALTER ROLE elloot_app PASSWORD '...';
    CREATE ROLE elloot_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT NOLOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT elloot_app TO %I', current_user);
EXCEPTION WHEN others THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA public TO elloot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO elloot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO elloot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO elloot_app;

-- Ledger is append-only: app role may SELECT only. Credits go through SECURITY DEFINER.
REVOKE INSERT, UPDATE, DELETE ON TABLE wallet_ledger FROM elloot_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE wallet_ledger FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '');
$$;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.user_role', true), ''), '');
$$;

CREATE OR REPLACE FUNCTION app_is_service() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_service', true), 'off') = 'on';
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_current_role() = 'ADMIN' OR app_is_service();
$$;

CREATE OR REPLACE FUNCTION wallet_ledger_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger is append-only; balance cannot be edited'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_ledger_no_update ON wallet_ledger;
CREATE TRIGGER trg_wallet_ledger_no_update
  BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_reject_mutation();

-- Runs as owner (privileged) so FOR UPDATE/INSERT work without granting
-- UPDATE/INSERT on wallet_ledger to elloot_app. Still gated by app_is_service().
CREATE OR REPLACE FUNCTION service_credit_wallet(
  p_id text,
  p_user_id text,
  p_order_id text,
  p_type "LedgerType",
  p_amount_cents integer,
  p_description text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev integer;
BEGIN
  IF NOT app_is_service() THEN
    RAISE EXCEPTION 'service context required for wallet credit'
      USING ERRCODE = '42501';
  END IF;

  IF p_amount_cents = 0 THEN
    RAISE EXCEPTION 'amount must be non-zero';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('wallet:' || p_user_id));

  SELECT wl."balanceAfter" INTO v_prev
  FROM wallet_ledger wl
  WHERE wl."userId" = p_user_id
  ORDER BY wl."createdAt" DESC, wl.id DESC
  LIMIT 1
  FOR UPDATE;

  INSERT INTO wallet_ledger (
    id, "userId", "orderId", type, "amountCents", "balanceAfter", description, "createdAt"
  ) VALUES (
    p_id,
    p_user_id,
    p_order_id,
    p_type,
    p_amount_cents,
    coalesce(v_prev, 0) + p_amount_cents,
    p_description,
    NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION service_credit_wallet(text, text, text, "LedgerType", integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION service_credit_wallet(text, text, text, "LedgerType", integer, text) TO elloot_app;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings FORCE ROW LEVEL SECURITY;
ALTER TABLE listing_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_media FORCE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE escrow_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes FORCE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;

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
  );

DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users FOR UPDATE
  USING (id = app_current_user_id() OR app_is_admin() OR app_is_service())
  WITH CHECK (id = app_current_user_id() OR app_is_admin() OR app_is_service());

CREATE OR REPLACE FUNCTION users_guard_update()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_is_service() OR app_is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash" THEN
    RAISE EXCEPTION 'passwordHash can only be changed by service'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.role = 'ADMIN' AND OLD.role IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'cannot self-elevate to ADMIN'
      USING ERRCODE = '42501';
  END IF;

  IF NEW."kycStatus" IS DISTINCT FROM OLD."kycStatus" AND NOT app_is_admin() THEN
    RAISE EXCEPTION 'kycStatus is not user-editable'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW."totpSecret" IS DISTINCT FROM OLD."totpSecret"
      OR NEW."totpEnabledAt" IS DISTINCT FROM OLD."totpEnabledAt")
     AND NOT app_is_admin() THEN
    RAISE EXCEPTION 'totp fields are not user-editable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_guard_update ON users;
CREATE TRIGGER trg_users_guard_update
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_guard_update();

DROP POLICY IF EXISTS users_insert ON users;
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (app_is_service() OR id = app_current_user_id());

DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING ("userId" = app_current_user_id() OR app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS accounts_insert ON accounts;
CREATE POLICY accounts_insert ON accounts FOR INSERT
  WITH CHECK ("userId" = app_current_user_id() OR app_is_service());

DROP POLICY IF EXISTS accounts_all_service ON accounts;
CREATE POLICY accounts_all_service ON accounts FOR ALL
  USING (app_is_service())
  WITH CHECK (app_is_service());

DROP POLICY IF EXISTS categories_select ON categories;
CREATE POLICY categories_select ON categories FOR SELECT USING (true);
DROP POLICY IF EXISTS categories_write ON categories;
CREATE POLICY categories_write ON categories FOR ALL
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS listings_select ON listings;
CREATE POLICY listings_select ON listings FOR SELECT
  USING (
    status = 'ACTIVE'
    OR "sellerId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o."listingId" = listings.id
        AND (
          o."buyerId" = app_current_user_id()
          OR o."sellerId" = app_current_user_id()
        )
    )
  );

DROP POLICY IF EXISTS listings_insert ON listings;
CREATE POLICY listings_insert ON listings FOR INSERT
  WITH CHECK ("sellerId" = app_current_user_id() OR app_is_service());

DROP POLICY IF EXISTS listings_update ON listings;
CREATE POLICY listings_update ON listings FOR UPDATE
  USING ("sellerId" = app_current_user_id() OR app_is_admin() OR app_is_service())
  WITH CHECK ("sellerId" = app_current_user_id() OR app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS listings_delete ON listings;
CREATE POLICY listings_delete ON listings FOR DELETE
  USING ("sellerId" = app_current_user_id() OR app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS listing_media_select ON listing_media;
CREATE POLICY listing_media_select ON listing_media FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = "listingId"
        AND (
          l.status = 'ACTIVE'
          OR l."sellerId" = app_current_user_id()
          OR app_is_admin()
          OR app_is_service()
          OR EXISTS (
            SELECT 1 FROM orders o
            WHERE o."listingId" = l.id
              AND (
                o."buyerId" = app_current_user_id()
                OR o."sellerId" = app_current_user_id()
              )
          )
        )
    )
  );

DROP POLICY IF EXISTS listing_media_write ON listing_media;
CREATE POLICY listing_media_write ON listing_media FOR ALL
  USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = "listingId" AND l."sellerId" = app_current_user_id()
    )
  )
  WITH CHECK (
    app_is_service() OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = "listingId" AND l."sellerId" = app_current_user_id()
    )
  );

DROP POLICY IF EXISTS orders_select ON orders;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (
    "buyerId" = app_current_user_id()
    OR "sellerId" = app_current_user_id()
    OR app_is_admin()
    OR app_is_service()
  );

DROP POLICY IF EXISTS orders_insert ON orders;
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK ("buyerId" = app_current_user_id() OR app_is_service());

DROP POLICY IF EXISTS orders_update ON orders;
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (app_is_service() OR app_is_admin())
  WITH CHECK (app_is_service() OR app_is_admin());

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT
  USING (
    app_is_service() OR app_is_admin() OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = "orderId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS payments_write ON payments;
CREATE POLICY payments_write ON payments FOR ALL
  USING (app_is_service() OR app_is_admin())
  WITH CHECK (app_is_service() OR app_is_admin());

DROP POLICY IF EXISTS escrow_select ON escrow_holds;
CREATE POLICY escrow_select ON escrow_holds FOR SELECT
  USING (
    app_is_service() OR app_is_admin() OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = "orderId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS escrow_write ON escrow_holds;
CREATE POLICY escrow_write ON escrow_holds FOR ALL
  USING (app_is_service() OR app_is_admin())
  WITH CHECK (app_is_service() OR app_is_admin());

DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (
    app_is_service() OR app_is_admin() OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = "orderId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS conversations_write ON conversations;
CREATE POLICY conversations_write ON conversations FOR ALL
  USING (app_is_service() OR app_is_admin())
  WITH CHECK (app_is_service() OR app_is_admin());

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT
  USING (
    app_is_service() OR app_is_admin() OR EXISTS (
      SELECT 1 FROM conversations c
      JOIN orders o ON o.id = c."orderId"
      WHERE c.id = "conversationId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS messages_insert ON messages;
CREATE POLICY messages_insert ON messages FOR INSERT
  WITH CHECK (
    "senderId" = app_current_user_id()
    AND EXISTS (
      SELECT 1 FROM conversations c
      JOIN orders o ON o.id = c."orderId"
      WHERE c.id = "conversationId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS disputes_select ON disputes;
CREATE POLICY disputes_select ON disputes FOR SELECT
  USING (
    app_is_service() OR app_is_admin() OR "openedById" = app_current_user_id() OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = "orderId"
        AND (o."buyerId" = app_current_user_id() OR o."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS disputes_insert ON disputes;
CREATE POLICY disputes_insert ON disputes FOR INSERT
  WITH CHECK ("openedById" = app_current_user_id() OR app_is_service());

DROP POLICY IF EXISTS disputes_update ON disputes;
CREATE POLICY disputes_update ON disputes FOR UPDATE
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS wallet_select ON wallet_ledger;
CREATE POLICY wallet_select ON wallet_ledger FOR SELECT
  USING ("userId" = app_current_user_id() OR app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS wallet_insert ON wallet_ledger;
CREATE POLICY wallet_insert ON wallet_ledger FOR INSERT
  WITH CHECK (app_is_service());

DROP POLICY IF EXISTS payouts_select ON payouts;
CREATE POLICY payouts_select ON payouts FOR SELECT
  USING ("userId" = app_current_user_id() OR app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS payouts_insert ON payouts;
CREATE POLICY payouts_insert ON payouts FOR INSERT
  WITH CHECK ("userId" = app_current_user_id() OR app_is_service());

DROP POLICY IF EXISTS payouts_update ON payouts;
CREATE POLICY payouts_update ON payouts FOR UPDATE
  USING (app_is_service() OR app_is_admin())
  WITH CHECK (app_is_service() OR app_is_admin());

DROP POLICY IF EXISTS audit_select ON audit_logs;
CREATE POLICY audit_select ON audit_logs FOR SELECT
  USING (app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS audit_insert ON audit_logs;
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (app_is_service() OR app_is_admin());

COMMIT;
