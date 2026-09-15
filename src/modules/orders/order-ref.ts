import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { orderWhereByRef } from "../../lib/entity-ref";

export { orderWhereByRef };

export async function findOrderIdByRef(
  tx: Prisma.TransactionClient,
  ref: string,
): Promise<string | null> {
  const order = await tx.order.findUnique({
    where: orderWhereByRef(ref),
    select: { id: true },
  });
  return order?.id ?? null;
}

export async function requireOrderIdByRef(
  tx: Prisma.TransactionClient,
  ref: string,
): Promise<string> {
  const id = await findOrderIdByRef(tx, ref);
  if (!id) {
    throw new AppError(404, "Order not found", "ORDER_NOT_FOUND");
  }
  return id;
}
