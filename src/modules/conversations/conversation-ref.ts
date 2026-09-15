import type { Prisma } from "@prisma/client";
import { isOrderCode } from "../../lib/public-codes";
import { findOrderIdByRef } from "../orders/order-ref";

/** Resolves chat URL ref (order code, conversation id, or legacy order id). */
export async function findConversationIdByRef(
  tx: Prisma.TransactionClient,
  ref: string,
): Promise<string | null> {
  if (isOrderCode(ref)) {
    const row = await tx.conversation.findFirst({
      where: { order: { code: ref } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  const byConversation = await tx.conversation.findUnique({
    where: { id: ref },
    select: { id: true },
  });
  if (byConversation) return byConversation.id;

  const orderId = await findOrderIdByRef(tx, ref);
  if (!orderId) return null;

  const byOrder = await tx.conversation.findUnique({
    where: { orderId },
    select: { id: true },
  });
  return byOrder?.id ?? null;
}
