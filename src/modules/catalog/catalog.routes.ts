import { Router } from "express";
import { withVisibilityBadges } from "../visibility/visibility.badges";
import type { Category, Prisma } from "@prisma/client";
import { withRlsTransaction } from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { resolveProductTypesForCategory } from "./product-types";
import { listActiveReachPlans } from "./reach-plans";

export const catalogRouter = Router();

const categoryPublicSelect = {
  id: true,
  parentId: true,
  externalId: true,
  name: true,
  slug: true,
  slugPath: true,
  status: true,
  orderInstruction: true,
  showInMenu: true,
  acceleratedRelease: true,
  interventionDeadlines: true,
  isFeatured: true,
  isAdult: true,
  imageUrl: true,
  iconUrl: true,
  icon: true,
  hasWebp: true,
  templateDescription: true,
  balanceReleaseDays: true,
  keywords: true,
  descriptionSeo: true,
  titleSeo: true,
  subtitleSeo: true,
  slugSeo: true,
  defaultOrderBy: true,
  childrenExternalIds: true,
  requiredUserValidation: true,
  isNoindex: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CategorySelect;

type CategoryRow = {
  id: string;
  parentId: string | null;
  externalId: number | null;
  name: string;
  slug: string;
  slugPath: string;
  status: Category["status"];
  orderInstruction: string | null;
  showInMenu: boolean;
  acceleratedRelease: boolean;
  interventionDeadlines: Category["interventionDeadlines"];
  isFeatured: boolean;
  isAdult: boolean;
  imageUrl: string | null;
  iconUrl: string | null;
  icon: string | null;
  hasWebp: boolean;
  templateDescription: string | null;
  balanceReleaseDays: number;
  keywords: string | null;
  descriptionSeo: string | null;
  titleSeo: string | null;
  subtitleSeo: string | null;
  slugSeo: string | null;
  defaultOrderBy: string;
  childrenExternalIds: string | null;
  requiredUserValidation: boolean;
  isNoindex: boolean | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

type SerializedCategory = {
  id: string;
  parentId: string | null;
  externalId: number | null;
  name: string;
  slug: string;
  slugPath: string;
  status: "active" | "inactive";
  orderInstruction: string;
  showInMenu: boolean;
  acceleratedRelease: boolean;
  interventionDeadlines: Category["interventionDeadlines"];
  isFeatured: boolean;
  isAdult: boolean;
  imageUrl: string | null;
  iconUrl: string | null;
  icon: string | null;
  hasWebp: boolean;
  templateDescription: string | null;
  balanceReleaseDays: number;
  keywords: string | null;
  descriptionSeo: string | null;
  titleSeo: string | null;
  subtitleSeo: string | null;
  slugSeo: string | null;
  defaultOrderBy: string;
  childrenExternalIds: string | null;
  requiredUserValidation: boolean;
  isNoindex: boolean | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  children?: SerializedCategory[];
};

function serializeCategory(
  row: CategoryRow,
  children?: SerializedCategory[],
): SerializedCategory {
  return {
    id: row.id,
    parentId: row.parentId,
    externalId: row.externalId,
    name: row.name,
    slug: row.slug,
    slugPath: row.slugPath,
    status: row.status === "ACTIVE" ? "active" : "inactive",
    orderInstruction: row.orderInstruction ?? "",
    showInMenu: row.showInMenu,
    acceleratedRelease: row.acceleratedRelease,
    interventionDeadlines: row.interventionDeadlines,
    isFeatured: row.isFeatured,
    isAdult: row.isAdult,
    imageUrl: row.imageUrl,
    iconUrl: row.iconUrl,
    icon: row.icon,
    hasWebp: row.hasWebp,
    templateDescription: row.templateDescription,
    balanceReleaseDays: row.balanceReleaseDays,
    keywords: row.keywords,
    descriptionSeo: row.descriptionSeo,
    titleSeo: row.titleSeo,
    subtitleSeo: row.subtitleSeo,
    slugSeo: row.slugSeo,
    defaultOrderBy: row.defaultOrderBy,
    childrenExternalIds: row.childrenExternalIds,
    requiredUserValidation: row.requiredUserValidation,
    isNoindex: row.isNoindex,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(children ? { children } : {}),
  };
}

/** Full category tree (N levels), GGMAX-style marketplace catalog. */
catalogRouter.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const featuredOnly = req.query.featured === "1" || req.query.featured === "true";
    const menuOnly = req.query.menu === "1" || req.query.menu === "true";

    const rows = await withRlsTransaction({ actor: null }, (tx) =>
      tx.category.findMany({
        where: {
          status: "ACTIVE",
          ...(featuredOnly ? { isFeatured: true } : {}),
          ...(menuOnly ? { showInMenu: true } : {}),
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: categoryPublicSelect,
      }),
    );

    const byParent = new Map<string | null, CategoryRow[]>();
    for (const row of rows) {
      const key = row.parentId;
      const list = byParent.get(key) ?? [];
      list.push(row);
      byParent.set(key, list);
    }

    function build(parentId: string | null): SerializedCategory[] {
      const children = byParent.get(parentId) ?? [];
      return children.map((row) => {
        const nested = build(row.id);
        return serializeCategory(row, nested.length ? nested : undefined);
      });
    }

    res.json({ success: true, categories: build(null) });
  }),
);

/**
 * Taxonomy for /sell (3 progressive selects):
 * 1) Categoria — Jogos + cada vertical de Outros (Redes Sociais, IA, Assinaturas…)
 * 2) Categoria principal — jogos OU itens da vertical
 * 3) Subcategoria — seções (Contas, Diamantes…), quando existirem
 */
catalogRouter.get(
  "/categories/listing",
  asyncHandler(async (_req, res) => {
    const rows = await withRlsTransaction({ actor: null }, (tx) =>
      tx.category.findMany({
        where: { status: "ACTIVE" },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: categoryPublicSelect,
      }),
    );

    const byParent = new Map<string | null, CategoryRow[]>();
    for (const row of rows) {
      const list = byParent.get(row.parentId) ?? [];
      list.push(row);
      byParent.set(row.parentId, list);
    }

    function nest(parentId: string): SerializedCategory[] {
      return (byParent.get(parentId) ?? []).map((row) => {
        const kids = nest(row.id);
        return serializeCategory(row, kids.length ? kids : undefined);
      });
    }

    const roots = byParent.get(null) ?? [];
    const sellRoots: SerializedCategory[] = [];

    for (const root of roots) {
      const mid = byParent.get(root.id) ?? [];

      // "Jogos" (e similares): um grupo L1 com jogos em L2 e seções em L3
      if (root.slug === "jogos" || mid.length > 20) {
        sellRoots.push(
          serializeCategory(
            root,
            mid.map((m) => {
              const sections = nest(m.id);
              return serializeCategory(m, sections.length ? sections : undefined);
            }),
          ),
        );
        continue;
      }

      // "Outros": promove cada filho a categoria L1 (Redes Sociais, IA, Discord…)
      if (root.slug === "outros" || root.slug === "other" || root.slug === "others") {
        for (const vertical of mid) {
          const main = nest(vertical.id);
          sellRoots.push(
            serializeCategory(
              vertical,
              main.length ? main : undefined,
            ),
          );
        }
        continue;
      }

      // Qualquer outro root: mantém com filhos aninhados
      sellRoots.push(
        serializeCategory(
          root,
          mid.map((m) => {
            const sections = nest(m.id);
            return serializeCategory(m, sections.length ? sections : undefined);
          }),
        ),
      );
    }

    sellRoots.sort((a, b) => {
      if (a.slug === "jogos") return -1;
      if (b.slug === "jogos") return 1;
      return a.name.localeCompare(b.name, "pt-BR");
    });

    res.json({ success: true, categories: sellRoots });
  }),
);

/** Configurable product kinds for the sell form ("O que você está vendendo?"). */
catalogRouter.get(
  "/product-types",
  asyncHandler(async (req, res) => {
    const categoryId =
      typeof req.query.categoryId === "string"
        ? req.query.categoryId.trim()
        : undefined;

    const productTypes = await withRlsTransaction({}, async (tx) =>
      resolveProductTypesForCategory(tx, categoryId || null),
    );

    res.json({ success: true, productTypes });
  }),
);

/** Active reach tiers for the sell form (fee % per sale). */
catalogRouter.get(
  "/reach-plans",
  asyncHandler(async (_req, res) => {
    const items = await withRlsTransaction({ actor: null }, async (tx) =>
      listActiveReachPlans(tx),
    );
    res.json({ success: true, items });
  }),
);

/** Flat list of mid-level categories (children of roots), or children of a given parent. */
catalogRouter.get(
  "/categories/flat",
  asyncHandler(async (req, res) => {
    const parent =
      typeof req.query.parent === "string" ? req.query.parent.trim() : undefined;
    const featuredOnly = req.query.featured === "1" || req.query.featured === "true";
    const menuOnly = req.query.menu === "1" || req.query.menu === "true";

    const categories = await withRlsTransaction({ actor: null }, async (tx) => {
      let parentId: string | undefined;
      if (parent) {
        const p = await tx.category.findFirst({
          where: {
            status: "ACTIVE",
            OR: [{ id: parent }, { slug: parent }, { slugPath: parent }],
          },
          select: { id: true },
        });
        parentId = p?.id;
        if (!parentId) return [];
      }

      return tx.category.findMany({
        where: {
          status: "ACTIVE",
          ...(parentId
            ? { parentId }
            : {
                // Mid-level only: parent is a root (Jogos / Outros), not sections
                parent: { parentId: null, status: "ACTIVE" },
              }),
          ...(featuredOnly ? { isFeatured: true } : {}),
          ...(menuOnly ? { showInMenu: true } : {}),
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: {
          ...categoryPublicSelect,
          parent: {
            select: { id: true, name: true, slug: true, slugPath: true },
          },
        },
      });
    });

    res.json({
      success: true,
      categories: categories.map((row) => ({
        ...serializeCategory(row),
        parent: row.parent,
      })),
    });
  }),
);

catalogRouter.get(
  "/listings",
  asyncHandler(async (req, res) => {
    const take = Math.min(Number(req.query.limit) || 20, 50);
    const category =
      typeof req.query.category === "string"
        ? req.query.category.trim()
        : typeof req.query.game === "string"
          ? req.query.game.trim()
          : undefined;
    const seller =
      typeof req.query.seller === "string" ? req.query.seller.trim() : undefined;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
    const cursor =
      typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const minPrice = Number(req.query.minPriceCents);
    const maxPrice = Number(req.query.maxPriceCents);
    const priceFilter =
      Number.isFinite(minPrice) || Number.isFinite(maxPrice)
        ? {
            ...(Number.isFinite(minPrice) ? { gte: minPrice } : {}),
            ...(Number.isFinite(maxPrice) ? { lte: maxPrice } : {}),
          }
        : undefined;
    const sortRaw =
      typeof req.query.sort === "string" ? req.query.sort.trim() : "recent";
    /** Default "recent" = exposição paga + plano de alcance + novidade. */
    const orderBy: Prisma.ListingOrderByWithRelationInput[] =
      sortRaw === "price_asc"
        ? [{ priceCents: "asc" }, { id: "asc" }]
        : sortRaw === "price_desc"
          ? [{ priceCents: "desc" }, { id: "desc" }]
          : sortRaw === "best_sellers" || sortRaw === "bestsellers"
            ? [
                { visibilityBoost: "desc" },
                { salesCount: "desc" },
                { createdAt: "desc" },
                { id: "desc" },
              ]
            : sortRaw === "reputation"
              ? [
                  { visibilityBoost: "desc" },
                  { seller: { reputationScore: "desc" } },
                  { salesCount: "desc" },
                  { id: "desc" },
                ]
              : [
                  { visibilityBoost: "desc" },
                  { reachPriority: "desc" },
                  { createdAt: "desc" },
                  { id: "desc" },
                ];

    const payload = await withRlsTransaction({ actor: null }, async (tx) => {
      let categoryFilter: Prisma.CategoryWhereInput | undefined;
      if (category) {
        const match = await tx.category.findFirst({
          where: {
            status: "ACTIVE",
            OR: [
              { id: category },
              { slug: category },
              { slugPath: category },
              { slugPath: { endsWith: `/${category}` } },
            ],
          },
          select: { id: true, slugPath: true },
        });
        if (!match) {
          return { listings: [] as Array<Record<string, unknown>>, nextCursor: null as string | null };
        }
        categoryFilter = {
          OR: [
            { id: match.id },
            { slugPath: { startsWith: `${match.slugPath}/` } },
          ],
        };
      }

      const listings = await tx.listing.findMany({
        where: {
          status: "ACTIVE",
          ...(seller ? { sellerId: seller } : {}),
          ...(priceFilter ? { priceCents: priceFilter } : {}),
          ...(q
            ? {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { description: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
          category: {
            status: "ACTIVE",
            ...categoryFilter,
          },
        },
        take,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy,
        select: {
          id: true,
          code: true,
          title: true,
          priceCents: true,
          status: true,
          listingModel: true,
          deliveryMode: true,
          productType: true,
          createdAt: true,
          category: {
            select: {
              id: true,
              slug: true,
              name: true,
              imageUrl: true,
              iconUrl: true,
              slugPath: true,
              parent: {
                select: {
                  id: true,
                  slug: true,
                  name: true,
                  imageUrl: true,
                  iconUrl: true,
                  slugPath: true,
                },
              },
            },
          },
          media: {
            orderBy: { sortOrder: "asc" },
            take: 4,
            select: { url: true },
          },
          _count: {
            select: { media: true },
          },
          seller: {
            select: { id: true, name: true },
          },
        },
      });

      const withBadges = await withVisibilityBadges(tx, listings);
      const nextCursor =
        listings.length === take ? listings[listings.length - 1]?.id ?? null : null;

      return {
        listings: withBadges.map(({ _count, visibilityBadges, ...listing }) => ({
          ...listing,
          mediaCount: _count.media,
          visibilityBadges,
        })),
        nextCursor,
      };
    });

    res.json(payload);
  }),
);

/**
 * Listing counts for a category and its direct children (sidebar badges).
 * Query: `?category=` id | slug | slugPath
 */
catalogRouter.get(
  "/category-stats",
  asyncHandler(async (req, res) => {
    const category =
      typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (!category) {
      res.json({ total: 0, children: [] });
      return;
    }

    const data = await withRlsTransaction({ actor: null }, async (tx) => {
      const match = await tx.category.findFirst({
        where: {
          status: "ACTIVE",
          OR: [
            { id: category },
            { slug: category },
            { slugPath: category },
            { slugPath: { endsWith: `/${category}` } },
          ],
        },
        select: {
          id: true,
          slugPath: true,
          children: {
            where: { status: "ACTIVE" },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
            select: { id: true, slug: true, slugPath: true, name: true },
          },
        },
      });
      if (!match) return null;

      const total = await tx.listing.count({
        where: {
          status: "ACTIVE",
          category: {
            status: "ACTIVE",
            OR: [
              { id: match.id },
              { slugPath: { startsWith: `${match.slugPath}/` } },
            ],
          },
        },
      });

      const children = await Promise.all(
        match.children.map(async (child) => {
          const count = await tx.listing.count({
            where: {
              status: "ACTIVE",
              category: {
                status: "ACTIVE",
                OR: [
                  { id: child.id },
                  { slugPath: { startsWith: `${child.slugPath}/` } },
                ],
              },
            },
          });
          return {
            id: child.id,
            slug: child.slug,
            slugPath: child.slugPath,
            name: child.name,
            count,
          };
        }),
      );

      return { total, children };
    });

    if (!data) {
      res.json({ total: 0, children: [] });
      return;
    }
    res.json(data);
  }),
);
