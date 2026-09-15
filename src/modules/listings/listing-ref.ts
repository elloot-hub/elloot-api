import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { listingWhereByRef } from "../../lib/entity-ref";

export { listingWhereByRef };

export async function findListingIdByRef(
  tx: Prisma.TransactionClient,
  ref: string,
): Promise<string | null> {
  const listing = await tx.listing.findUnique({
    where: listingWhereByRef(ref),
    select: { id: true },
  });
  return listing?.id ?? null;
}

export async function requireListingIdByRef(
  tx: Prisma.TransactionClient,
  ref: string,
): Promise<string> {
  const id = await findListingIdByRef(tx, ref);
  if (!id) {
    throw new AppError(404, "Listing not found", "LISTING_NOT_FOUND");
  }
  return id;
}
