/**
 * Media garbage collection CLI.
 *
 * Default: dry-run (report only).
 *   npx tsx scripts/media-gc.ts
 * Apply soft-delete:
 *   npx tsx scripts/media-gc.ts --apply
 * Soft-delete + purge storage after grace:
 *   npx tsx scripts/media-gc.ts --apply --purge
 */
import "../src/config/env";
import { runMediaGc } from "../src/modules/media/media.gc";
import { prisma } from "../src/databases";

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = !args.has("--apply");
  const purge = args.has("--purge");

  const result = await runMediaGc({
    dryRun,
    softDelete: true,
    purge: purge && !dryRun,
  });

  console.log(JSON.stringify(result, null, 2));
  if (dryRun) {
    console.log(
      "Dry-run only. Re-run with --apply to soft-delete, add --purge to remove storage after grace.",
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
