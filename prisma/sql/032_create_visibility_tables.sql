-- Create visibility / home section tables (idempotent; used when db push is blocked).

DO $$ BEGIN
  CREATE TYPE "VisibilityScope" AS ENUM ('GLOBAL', 'CATEGORY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "HomeSectionSource" AS ENUM ('PLACEMENT', 'CATEGORY', 'METRIC', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "HomeSectionLayout" AS ENUM ('GRID', 'CAROUSEL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "HomeSectionMetric" AS ENUM ('RECENT', 'BEST_SELLING', 'MOST_FAVORITED', 'MOST_VIEWED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ListingPlacementStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS visibility_products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  "priceCents" INTEGER NOT NULL,
  "durationHours" INTEGER NOT NULL,
  scope "VisibilityScope" NOT NULL DEFAULT 'GLOBAL',
  "categoryId" TEXT REFERENCES categories(id) ON DELETE SET NULL,
  "maxActiveSlots" INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  "badgeLabel" TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS visibility_products_active_sort_idx
  ON visibility_products (active, "sortOrder");
CREATE INDEX IF NOT EXISTS visibility_products_category_idx
  ON visibility_products ("categoryId");

CREATE TABLE IF NOT EXISTS home_sections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  source "HomeSectionSource" NOT NULL,
  layout "HomeSectionLayout" NOT NULL DEFAULT 'GRID',
  "productIds" TEXT[] NOT NULL DEFAULT '{}',
  "categoryId" TEXT REFERENCES categories(id) ON DELETE SET NULL,
  metric "HomeSectionMetric",
  "manualListingIds" TEXT[] NOT NULL DEFAULT '{}',
  "itemLimit" INTEGER NOT NULL DEFAULT 10,
  columns INTEGER NOT NULL DEFAULT 5,
  "viewMoreHref" TEXT,
  "viewMoreLabel" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS home_sections_active_sort_idx
  ON home_sections (active, "sortOrder");
CREATE INDEX IF NOT EXISTS home_sections_category_idx
  ON home_sections ("categoryId");

CREATE TABLE IF NOT EXISTS listing_placements (
  id TEXT PRIMARY KEY,
  "listingId" TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  "productId" TEXT NOT NULL REFERENCES visibility_products(id) ON DELETE RESTRICT,
  status "ListingPlacementStatus" NOT NULL DEFAULT 'PENDING',
  "startsAt" TIMESTAMPTZ,
  "endsAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS listing_placements_listing_status_idx
  ON listing_placements ("listingId", status);
CREATE INDEX IF NOT EXISTS listing_placements_product_status_idx
  ON listing_placements ("productId", status);
CREATE INDEX IF NOT EXISTS listing_placements_status_ends_idx
  ON listing_placements (status, "endsAt");
