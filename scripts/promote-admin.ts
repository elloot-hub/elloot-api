/**
 * Promote a user to ADMIN by email.
 * Usage: npm run admin:promote -- user@example.com
 */
import "../src/config/env";
import { prisma, withServiceTransaction } from "../src/databases";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: npm run admin:promote -- <email>");
    process.exit(1);
  }

  const result = await withServiceTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) {
      return { status: "not_found" as const };
    }

    if (user.role === "ADMIN") {
      return { status: "already_admin" as const, user };
    }

    await tx.user.update({
      where: { id: user.id },
      data: { role: "ADMIN" },
    });

    return { status: "promoted" as const, user };
  });

  if (result.status === "not_found") {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  if (result.status === "already_admin") {
    console.log(`Already ADMIN: ${email}`);
    process.exit(0);
  }

  console.log(`Promoted to ADMIN: ${email} (${result.user.id})`);
  if (!result.user.passwordHash) {
    console.warn(
      "This account has no password. Set one via register flow or DB before admin login.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
