/**
 * Set/replace a user's password (admin bootstrap).
 * Usage: NEW_PASSWORD='...' npx tsx scripts/set-user-password.ts user@example.com
 */
import bcrypt from "bcryptjs";
import "../src/config/env";
import { prisma, withServiceTransaction } from "../src/databases";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const password = process.env.NEW_PASSWORD ?? "";
  if (!email || password.length < 8) {
    console.error(
      "Usage: NEW_PASSWORD='...' npx tsx scripts/set-user-password.ts <email>",
    );
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await withServiceTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) return { status: "not_found" as const };
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    return { status: "ok" as const, id: user.id, role: user.role };
  });

  if (result.status === "not_found") {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ok: true,
      email,
      id: result.id,
      role: result.role,
      hasPassword: true,
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
