/**
 * Approve KYC for a user by email (dev/testing).
 * Usage: npx tsx scripts/approve-kyc.ts user@example.com
 */
import "../src/config/env";
import { prisma, withServiceTransaction } from "../src/databases";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("Usage: npx tsx scripts/approve-kyc.ts <email>");
    process.exit(1);
  }

  const result = await withServiceTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } });
    if (!user) {
      return { status: "not_found" as const };
    }

    if (user.kycStatus === "APPROVED") {
      return { status: "already_approved" as const, user };
    }

    await tx.user.update({
      where: { id: user.id },
      data: { kycStatus: "APPROVED" },
    });

    return { status: "approved" as const, user };
  });

  if (result.status === "not_found") {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  if (result.status === "already_approved") {
    console.log(`KYC already APPROVED: ${email} (${result.user.id})`);
    process.exit(0);
  }

  console.log(`KYC APPROVED: ${email} (${result.user.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
