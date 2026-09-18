import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";

export type ProductTypeOption = {
  value: string;
  label: string;
};

type Tx = {
  productType: {
    findMany: (args: {
      where?: Prisma.ProductTypeWhereInput;
      orderBy?: Prisma.ProductTypeOrderByWithRelationInput[];
      select: { id: true; code: true; label: true; sortOrder: true };
    }) => Promise<
      Array<{ id: string; code: string; label: string; sortOrder: number }>
    >;
  };
  categoryProductType: {
    findMany: (args: {
      where: Prisma.CategoryProductTypeWhereInput;
      orderBy?: Prisma.CategoryProductTypeOrderByWithRelationInput[];
      select: {
        enabled: true;
        sortOrder: true;
        labelOverride: true;
        productType: {
          select: { id: true; code: true; label: true; active: true; sortOrder: true };
        };
      };
    }) => Promise<
      Array<{
        enabled: boolean;
        sortOrder: number;
        labelOverride: string | null;
        productType: {
          id: string;
          code: string;
          label: string;
          active: boolean;
          sortOrder: number;
        };
      }>
    >;
  };
  category: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; parentId: true };
    }) => Promise<{ id: string; parentId: string | null } | null>;
  };
};

async function globalActiveTypes(tx: Tx): Promise<ProductTypeOption[]> {
  const rows = await tx.productType.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { id: true, code: true, label: true, sortOrder: true },
  });
  return rows.map((r) => ({ value: r.code, label: r.label }));
}

/**
 * Resolve sell-form options for a category:
 * 1) own CategoryProductType rows (enabled + active type)
 * 2) else walk parents
 * 3) else all active global types
 */
export async function resolveProductTypesForCategory(
  tx: Tx,
  categoryId: string | null | undefined,
): Promise<ProductTypeOption[]> {
  if (!categoryId) return globalActiveTypes(tx);

  let currentId: string | null = categoryId;
  const seen = new Set<string>();

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const links = await tx.categoryProductType.findMany({
      where: { categoryId: currentId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: {
        enabled: true,
        sortOrder: true,
        labelOverride: true,
        productType: {
          select: {
            id: true,
            code: true,
            label: true,
            active: true,
            sortOrder: true,
          },
        },
      },
    });

    if (links.length > 0) {
      return links
        .filter((l) => l.enabled && l.productType.active)
        .map((l) => ({
          value: l.productType.code,
          label: l.labelOverride?.trim() || l.productType.label,
        }));
    }

    const cat = await tx.category.findUnique({
      where: { id: currentId },
      select: { id: true, parentId: true },
    });
    currentId = cat?.parentId ?? null;
  }

  return globalActiveTypes(tx);
}

export async function assertProductTypeAllowed(
  tx: Tx,
  categoryId: string,
  productType: string | null | undefined,
) {
  if (!productType) return;
  const allowed = await resolveProductTypesForCategory(tx, categoryId);
  if (!allowed.some((t) => t.value === productType)) {
    throw new AppError(
      400,
      "Product type not allowed for this category",
      "INVALID_PRODUCT_TYPE",
    );
  }
}
