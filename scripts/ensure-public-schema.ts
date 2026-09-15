/**
 * Best-effort GRANT CREATE on public schema (PG15+ / managed hosts).
 */
import "../src/config/env";
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ u: string; d: string; can_create: boolean }>
    >(
      `select current_user as u, current_database() as d,
        has_schema_privilege(current_user, 'public', 'CREATE') as can_create`,
    );
    console.log("session", rows);

    try {
      await prisma.$executeRawUnsafe(
        "GRANT ALL ON SCHEMA public TO CURRENT_USER",
      );
      await prisma.$executeRawUnsafe(
        "GRANT CREATE ON SCHEMA public TO CURRENT_USER",
      );
    } catch (e) {
      console.warn("grant skipped:", e instanceof Error ? e.message : e);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
