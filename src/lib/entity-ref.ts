import type { Prisma } from "@prisma/client";
import {
  isDisputeCode,
  isListingCode,
  isOrderCode,
  isPayoutCode,
} from "./public-codes";

export function orderWhereByRef(ref: string): Prisma.OrderWhereUniqueInput {
  if (isOrderCode(ref)) return { code: ref };
  return { id: ref };
}

export function listingWhereByRef(ref: string): Prisma.ListingWhereUniqueInput {
  if (isListingCode(ref)) return { code: ref };
  return { id: ref };
}

export function disputeWhereByRef(ref: string): Prisma.DisputeWhereUniqueInput {
  if (isDisputeCode(ref)) return { code: ref };
  return { id: ref };
}

export function payoutWhereByRef(ref: string): Prisma.PayoutWhereUniqueInput {
  if (isPayoutCode(ref)) return { code: ref };
  return { id: ref };
}
