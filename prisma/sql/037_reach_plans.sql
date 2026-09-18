-- Reach plans: % fee per sale chosen when creating a listing.

CREATE TABLE IF NOT EXISTS "reach_plans" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "feeBps" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "barLevel" INTEGER NOT NULL DEFAULT 1,
  "recommended" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reach_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reach_plans_code_key" ON "reach_plans"("code");
CREATE INDEX IF NOT EXISTS "reach_plans_active_sortOrder_idx"
  ON "reach_plans"("active", "sortOrder");

ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "reachPlanId" TEXT;
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "feeBps" INTEGER;
ALTER TABLE "listings" ADD COLUMN IF NOT EXISTS "reachPriority" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "listings_reachPlanId_idx" ON "listings"("reachPlanId");
CREATE INDEX IF NOT EXISTS "listings_status_reachPriority_createdAt_idx"
  ON "listings"("status", "reachPriority", "createdAt");

DO $$ BEGIN
  ALTER TABLE "listings"
    ADD CONSTRAINT "listings_reachPlanId_fkey"
    FOREIGN KEY ("reachPlanId") REFERENCES "reach_plans"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "reach_plans" (
  "id", "code", "title", "description", "feeBps", "priority", "barLevel",
  "recommended", "active", "sortOrder", "createdAt", "updatedAt"
)
VALUES
  (
    'rp_min', 'MIN', 'Alcance mínimo',
    'Seu anúncio aparece normalmente nas buscas e categorias',
    600, 10, 1, false, true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'rp_mid', 'MID', 'Alcance médio',
    'Destaque em pesquisas e categorias: mais visitas e mais chances de vender',
    800, 20, 2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'rp_max', 'MAX', 'Alcance máximo',
    'Prioridade nas buscas, categorias e na vitrine da página inicial',
    1200, 30, 4, true, true, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
ON CONFLICT ("code") DO NOTHING;

GRANT SELECT ON TABLE reach_plans TO elloot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reach_plans TO elloot_app;

ALTER TABLE reach_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE reach_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reach_plans_select ON reach_plans;
CREATE POLICY reach_plans_select ON reach_plans FOR SELECT USING (true);

DROP POLICY IF EXISTS reach_plans_write ON reach_plans;
CREATE POLICY reach_plans_write ON reach_plans FOR ALL
  USING (app_is_admin() OR app_is_service())
  WITH CHECK (app_is_admin() OR app_is_service());
