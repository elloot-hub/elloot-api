-- Auto-delivery stock items (keys/credentials per listing or offer)

DO $$ BEGIN
  CREATE TYPE "DeliveryStockStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'CONSUMED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS delivery_stock_items (
  id TEXT PRIMARY KEY,
  "listingId" TEXT REFERENCES listings(id) ON DELETE CASCADE,
  "offerId" TEXT REFERENCES listing_offers(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status "DeliveryStockStatus" NOT NULL DEFAULT 'AVAILABLE',
  "orderId" TEXT UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT delivery_stock_items_target_chk CHECK (
    ("listingId" IS NOT NULL AND "offerId" IS NULL)
    OR ("listingId" IS NULL AND "offerId" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS delivery_stock_items_listing_status_idx
  ON delivery_stock_items ("listingId", status)
  WHERE "listingId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS delivery_stock_items_offer_status_idx
  ON delivery_stock_items ("offerId", status)
  WHERE "offerId" IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE delivery_stock_items TO elloot_app;

ALTER TABLE delivery_stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_stock_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_stock_items_select ON delivery_stock_items;
CREATE POLICY delivery_stock_items_select ON delivery_stock_items FOR SELECT
  USING (
    app_is_service()
    OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = delivery_stock_items."listingId"
        AND l."sellerId" = app_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM listing_offers o
      JOIN listings l ON l.id = o."listingId"
      WHERE o.id = delivery_stock_items."offerId"
        AND l."sellerId" = app_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM orders ord
      WHERE ord.id = delivery_stock_items."orderId"
        AND (ord."buyerId" = app_current_user_id() OR ord."sellerId" = app_current_user_id())
    )
  );

DROP POLICY IF EXISTS delivery_stock_items_write ON delivery_stock_items;
CREATE POLICY delivery_stock_items_insert ON delivery_stock_items FOR INSERT
  WITH CHECK (
    app_is_service()
    OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = delivery_stock_items."listingId"
        AND l."sellerId" = app_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM listing_offers o
      JOIN listings l ON l.id = o."listingId"
      WHERE o.id = delivery_stock_items."offerId"
        AND l."sellerId" = app_current_user_id()
    )
  );

CREATE POLICY delivery_stock_items_update ON delivery_stock_items FOR UPDATE
  USING (app_is_service())
  WITH CHECK (app_is_service());

CREATE POLICY delivery_stock_items_delete ON delivery_stock_items FOR DELETE
  USING (
    app_is_service()
    OR EXISTS (
      SELECT 1 FROM listings l
      WHERE l.id = delivery_stock_items."listingId"
        AND l."sellerId" = app_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM listing_offers o
      JOIN listings l ON l.id = o."listingId"
      WHERE o.id = delivery_stock_items."offerId"
        AND l."sellerId" = app_current_user_id()
    )
  );
