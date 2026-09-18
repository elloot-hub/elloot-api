-- Global product types + per-category sell options.

CREATE TABLE IF NOT EXISTS "product_types" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_types_code_key" ON "product_types"("code");
CREATE INDEX IF NOT EXISTS "product_types_active_sortOrder_idx"
  ON "product_types"("active", "sortOrder");

CREATE TABLE IF NOT EXISTS "category_product_types" (
  "id" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "productTypeId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "labelOverride" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "category_product_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "category_product_types_categoryId_productTypeId_key"
  ON "category_product_types"("categoryId", "productTypeId");
CREATE INDEX IF NOT EXISTS "category_product_types_categoryId_enabled_sortOrder_idx"
  ON "category_product_types"("categoryId", "enabled", "sortOrder");

DO $$ BEGIN
  ALTER TABLE "category_product_types"
    ADD CONSTRAINT "category_product_types_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "category_product_types"
    ADD CONSTRAINT "category_product_types_productTypeId_fkey"
    FOREIGN KEY ("productTypeId") REFERENCES "product_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Seed defaults (idempotent by code).
INSERT INTO "product_types" ("id", "code", "label", "sortOrder", "active", "createdAt", "updatedAt")
VALUES
  ('pt_servico', 'SERVICO', 'Serviço', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pt_conta', 'CONTA', 'Conta', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pt_gold', 'GOLD', 'Gold', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pt_item', 'ITEM', 'Item', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('pt_outros', 'OUTROS', 'Outros', 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

GRANT SELECT ON TABLE product_types TO elloot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_types TO elloot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE category_product_types TO elloot_app;

ALTER TABLE product_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_types FORCE ROW LEVEL SECURITY;
ALTER TABLE category_product_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_product_types FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_types_select ON product_types;
CREATE POLICY product_types_select ON product_types FOR SELECT USING (true);

DROP POLICY IF EXISTS product_types_write ON product_types;
CREATE POLICY product_types_write ON product_types FOR ALL
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());

DROP POLICY IF EXISTS category_product_types_select ON category_product_types;
CREATE POLICY category_product_types_select ON category_product_types FOR SELECT USING (true);

DROP POLICY IF EXISTS category_product_types_write ON category_product_types;
CREATE POLICY category_product_types_write ON category_product_types FOR ALL
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());
