/**
 * Destructive wipe: all marketplace listings ("produtos") and categories,
 * including rows that reference them (orders, chats, reviews, etc.).
 *
 * Users / auth are kept. Order-linked wallet rows are removed (owner role).
 * Home sections lose category + manual listing refs.
 *
 * Usage: CONFIRM_WIPE_CATALOG=YES npx tsx scripts/wipe-catalog.ts
 *
 * Runs as the DB connection owner (not elloot_app) so wallet_ledger
 * append-only trigger can be bypassed for this maintenance wipe.
 */
import "../src/config/env";
import { prisma } from "../src/databases";

async function main() {
  if (process.env.CONFIRM_WIPE_CATALOG !== "YES") {
    console.error(
      "Refused: set CONFIRM_WIPE_CATALOG=YES to wipe listings + categories.",
    );
    process.exit(1);
  }

  const before = {
    listings: await prisma.listing.count(),
    categories: await prisma.category.count(),
    orders: await prisma.order.count(),
  };
  console.log("Before:", before);

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.homeSection.updateMany({
        data: { categoryId: null, manualListingIds: [] },
      });
      await tx.visibilityProduct.updateMany({
        data: { categoryId: null },
      });

      await tx.message.deleteMany({});
      await tx.conversation.deleteMany({});
      await tx.review.deleteMany({});
      await tx.dispute.deleteMany({});
      await tx.escrowHold.deleteMany({});
      await tx.payment.deleteMany({});

      // wallet_ledger blocks DELETE via trigger for app role; owner can disable.
      await tx.$executeRawUnsafe(
        `ALTER TABLE wallet_ledger DISABLE TRIGGER trg_wallet_ledger_no_update`,
      );
      try {
        await tx.walletLedger.deleteMany({
          where: { orderId: { not: null } },
        });
      } finally {
        await tx.$executeRawUnsafe(
          `ALTER TABLE wallet_ledger ENABLE TRIGGER trg_wallet_ledger_no_update`,
        );
      }

      await tx.deliveryStockItem.deleteMany({});
      await tx.order.deleteMany({});

      await tx.listingPlacement.deleteMany({});
      await tx.favorite.deleteMany({});
      await tx.listingEvent.deleteMany({});
      await tx.listingQuestion.deleteMany({});
      await tx.listingModerationQueue.deleteMany({});
      await tx.listingMedia.deleteMany({});
      await tx.listingOffer.deleteMany({});
      await tx.listing.deleteMany({});

      let categoriesDeleted = 0;
      for (let i = 0; i < 50; i++) {
        const leaves = await tx.category.findMany({
          where: { children: { none: {} } },
          select: { id: true },
        });
        if (leaves.length === 0) break;
        const del = await tx.category.deleteMany({
          where: { id: { in: leaves.map((c) => c.id) } },
        });
        categoriesDeleted += del.count;
      }

      const remainingCategories = await tx.category.count();
      if (remainingCategories > 0) {
        throw new Error(
          `Could not delete all categories (${remainingCategories} left)`,
        );
      }

      return {
        categoriesDeleted,
        listingsLeft: await tx.listing.count(),
        categoriesLeft: remainingCategories,
        ordersLeft: await tx.order.count(),
      };
    },
    { maxWait: 30_000, timeout: 180_000 },
  );

  console.log("After:", result);
  console.log(JSON.stringify({ ok: true, before, result }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
