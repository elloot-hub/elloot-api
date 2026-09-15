import { randomBytes } from "node:crypto";
import type { LedgerType, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { isOrderCode } from "../../lib/public-codes";

export type DbClient = PrismaClient | Prisma.TransactionClient;

export type RlsActor = {
  id: string;
  role: "BUYER" | "SELLER" | "ADMIN";
};

type TxOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  asService?: boolean;
  actor?: RlsActor | null;
  timeout?: number;
};

function newId() {
  return `c${Date.now().toString(36)}${randomBytes(10).toString("hex")}`;
}

async function applySession(tx: Prisma.TransactionClient, options: TxOptions) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE elloot_app`);

  const userId = options.actor?.id ?? "";
  const role = options.actor?.role ?? "";
  const isService = options.asService ? "on" : "off";

  await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true)`;
  await tx.$executeRaw`SELECT set_config('app.is_service', ${isService}, true)`;
}

export async function withRlsTransaction<T>(
  options: TxOptions,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await applySession(tx, options);
      return fn(tx);
    },
    {
      isolationLevel: options.isolationLevel ?? "ReadCommitted",
      maxWait: 10_000,
      timeout: options.timeout ?? 45_000,
    },
  );
}

export async function withServiceTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  actor?: RlsActor | null,
): Promise<T> {
  return withRlsTransaction({ asService: true, actor: actor ?? null }, fn);
}

/** Append-only atomic wallet credit (advisory lock + FOR UPDATE inside SQL). */
export async function creditWallet(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    orderId?: string | null;
    type: LedgerType;
    amountCents: number;
    description?: string;
  },
) {
  const id = newId();
  await tx.$executeRawUnsafe(
    `SELECT service_credit_wallet($1, $2, $3, $4::"LedgerType", $5::integer, $6)`,
    id,
    input.userId,
    input.orderId ?? null,
    input.type,
    Number(input.amountCents),
    input.description ?? null,
  );
  return id;
}

/**
 * Take the same wallet advisory lock used by service_credit_wallet so
 * balance checks + debit in one transaction are serialized per user.
 */
export async function lockWalletUser(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  await tx.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    `wallet:${userId}`,
  );
}

export type LockedListing = {
  id: string;
  sellerId: string;
  categoryId: string;
  title: string;
  description: string;
  priceCents: number;
  stockQuantity: number;
  listingModel: string;
  status: string;
  deliveryMode: string;
};

export async function lockListingForUpdate(
  tx: Prisma.TransactionClient,
  listingId: string,
): Promise<LockedListing | null> {
  const rows = await tx.$queryRaw<LockedListing[]>`
    SELECT
      id,
      "sellerId",
      "categoryId",
      title,
      description,
      "priceCents",
      "stockQuantity",
      "listingModel"::text AS "listingModel",
      status::text AS status,
      "deliveryMode"::text AS "deliveryMode"
    FROM listings
    WHERE id = ${listingId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type LockedOffer = {
  id: string;
  listingId: string;
  title: string;
  priceCents: number;
  stockQuantity: number;
  deliveryMode: string;
};

export async function lockOfferForUpdate(
  tx: Prisma.TransactionClient,
  offerId: string,
): Promise<LockedOffer | null> {
  const rows = await tx.$queryRaw<LockedOffer[]>`
    SELECT
      id,
      "listingId",
      title,
      "priceCents",
      "stockQuantity",
      "deliveryMode"::text AS "deliveryMode"
    FROM listing_offers
    WHERE id = ${offerId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type LockedOrder = {
  id: string;
  code: string;
  listingId: string;
  offerId: string | null;
  buyerId: string;
  sellerId: string;
  amountCents: number;
  feeCents: number;
  status: string;
  expiresAt: Date | null;
};

export async function lockOrderForUpdate(
  tx: Prisma.TransactionClient,
  orderRef: string,
): Promise<LockedOrder | null> {
  const whereSql = isOrderCode(orderRef)
    ? Prisma.sql`code = ${orderRef}`
    : Prisma.sql`id = ${orderRef}`;
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT
      id,
      code,
      "listingId",
      "offerId",
      "buyerId",
      "sellerId",
      "amountCents",
      "feeCents",
      status::text AS status,
      "expiresAt"
    FROM orders
    WHERE ${whereSql}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}
