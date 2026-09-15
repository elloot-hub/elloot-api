/**
 * Diagnose admin login eligibility (no secrets printed).
 * Usage: npx tsx scripts/check-admin-user.ts user@example.com
 */
import "../src/config/env";
import { prisma, withServiceTransaction } from "../src/databases";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: npx tsx scripts/check-admin-user.ts <email>");
    process.exit(1);
  }

  const user = await withServiceTransaction(async (tx) =>
    tx.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        role: true,
        passwordHash: true,
        totpEnabledAt: true,
      },
    }),
  );

  if (!user) {
    console.log(JSON.stringify({ found: false, email }));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      found: true,
      email: user.email,
      role: user.role,
      hasPassword: Boolean(user.passwordHash),
      totpEnabled: Boolean(user.totpEnabledAt),
      isAdmin: user.role === "ADMIN",
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
