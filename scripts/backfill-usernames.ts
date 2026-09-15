/**
 * Assign usernames to users that still lack one.
 * Usage: npx tsx scripts/backfill-usernames.ts
 */
import "../src/config/env";
import { prisma, withServiceTransaction } from "../src/databases";
import { allocateUsername } from "../src/lib/username";

async function main() {
  const users = await prisma.user.findMany({
    where: { OR: [{ username: null }, { username: "" }] },
    select: { id: true, email: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let assigned = 0;
  for (const user of users) {
    await withServiceTransaction(async (tx) => {
      const username = await allocateUsername(tx, {
        email: user.email,
        name: user.name,
        excludeUserId: user.id,
      });
      await tx.user.update({
        where: { id: user.id },
        data: { username },
      });
      console.log(`${user.email} → @${username}`);
      assigned += 1;
    });
  }

  console.log(`Done. Assigned ${assigned} username(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
