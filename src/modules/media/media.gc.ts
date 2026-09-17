import type { MediaPurpose, Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { withServiceTransaction } from "../../databases";
import { deleteObject } from "./media.storage";

export type MediaGcOptions = {
  /** When true, only report candidates — no DB/storage writes. Default true. */
  dryRun?: boolean;
  /** Soft-delete orphans older than orphanAgeHours. Default true. */
  softDelete?: boolean;
  /** Delete storage + keep soft-deleted row for assets soft-deleted longer than purgeAfterDays. */
  purge?: boolean;
  orphanAgeHours?: number;
  purgeAfterDays?: number;
  /** Incomplete presign leftovers (sizeBytes=0). Default 1h. */
  incompleteAgeHours?: number;
  /** Max rows to process per run. */
  limit?: number;
};

export type MediaGcResult = {
  dryRun: boolean;
  orphanCandidates: number;
  softDeleted: number;
  incompleteCandidates: number;
  incompleteSoftDeleted: number;
  purgeCandidates: number;
  purged: number;
  sampleIds: string[];
};

const CLIENT_PURPOSES: MediaPurpose[] = ["AVATAR", "GENERAL", "LISTING"];

type Tx = Prisma.TransactionClient;

async function loadReferencedUrls(tx: Tx): Promise<Set<string>> {
  const urls = new Set<string>();

  const listingMedia = await tx.listingMedia.findMany({
    select: { url: true },
  });
  for (const row of listingMedia) {
    if (row.url) urls.add(row.url);
  }

  const users = await tx.user.findMany({
    where: { avatarUrl: { not: null } },
    select: { avatarUrl: true },
  });
  for (const row of users) {
    if (row.avatarUrl) urls.add(row.avatarUrl);
  }

  const categories = await tx.category.findMany({
    where: {
      OR: [{ imageUrl: { not: null } }, { iconUrl: { not: null } }],
    },
    select: { imageUrl: true, iconUrl: true },
  });
  for (const row of categories) {
    if (row.imageUrl) urls.add(row.imageUrl);
    if (row.iconUrl) urls.add(row.iconUrl);
  }

  return urls;
}

async function loadKycAssetIds(tx: Tx): Promise<Set<string>> {
  const ids = new Set<string>();
  const rows = await tx.kycSubmission.findMany({
    select: {
      frontAssetId: true,
      backAssetId: true,
      selfieAssetId: true,
    },
  });
  for (const row of rows) {
    ids.add(row.frontAssetId);
    ids.add(row.backAssetId);
    ids.add(row.selfieAssetId);
  }
  return ids;
}

async function loadModerationReferencedIds(tx: Tx): Promise<Set<string>> {
  const ids = new Set<string>();
  const pending = await tx.listingModerationQueue.findMany({
    where: { status: "PENDING" },
    select: { payload: true },
    take: 500,
  });
  for (const row of pending) {
    const text = JSON.stringify(row.payload ?? {});
    // Capture cuid-like and uuid-like tokens that appear as mediaAssetIds.
    const matches = text.match(/["']([a-z][a-z0-9]{20,})["']/gi) ?? [];
    for (const m of matches) {
      ids.add(m.replace(/['"]/g, ""));
    }
  }
  return ids;
}

function isReferenced(input: {
  id: string;
  code: string;
  url: string;
  urlSet: Set<string>;
  kycIds: Set<string>;
  moderationIds: Set<string>;
}) {
  if (input.kycIds.has(input.id)) return true;
  if (input.moderationIds.has(input.id)) return true;
  if (input.moderationIds.has(input.code)) return true;
  if (input.urlSet.has(input.url)) return true;
  for (const u of input.urlSet) {
    if (u.includes(input.id) || u.includes(input.code)) return true;
  }
  return false;
}

/**
 * Conservative media garbage collection.
 * Never deletes CATEGORY assets. Never hard-deletes without prior soft-delete grace.
 */
export async function runMediaGc(
  options: MediaGcOptions = {},
): Promise<MediaGcResult> {
  const dryRun = options.dryRun ?? true;
  const softDelete = options.softDelete ?? true;
  const purge = options.purge ?? false;
  const orphanAgeHours =
    options.orphanAgeHours ?? env.MEDIA_GC_ORPHAN_AGE_HOURS;
  const purgeAfterDays =
    options.purgeAfterDays ?? env.MEDIA_GC_PURGE_AFTER_DAYS;
  const incompleteAgeHours =
    options.incompleteAgeHours ?? env.MEDIA_GC_INCOMPLETE_AGE_HOURS;
  const limit = options.limit ?? 200;

  const orphanBefore = new Date(Date.now() - orphanAgeHours * 3_600_000);
  const incompleteBefore = new Date(
    Date.now() - incompleteAgeHours * 3_600_000,
  );
  const purgeBefore = new Date(Date.now() - purgeAfterDays * 86_400_000);

  return withServiceTransaction(async (tx) => {
    const urlSet = await loadReferencedUrls(tx);
    const kycIds = await loadKycAssetIds(tx);
    const moderationIds = await loadModerationReferencedIds(tx);

    const candidates = await tx.mediaAsset.findMany({
      where: {
        deletedAt: null,
        purpose: { in: CLIENT_PURPOSES },
        createdAt: { lt: orphanBefore },
      },
      orderBy: { createdAt: "asc" },
      take: limit * 3,
      select: {
        id: true,
        code: true,
        url: true,
        key: true,
        purpose: true,
        sizeBytes: true,
        checksumSha256: true,
        createdAt: true,
      },
    });

    const orphans = candidates
      .filter(
        (row) =>
          !isReferenced({
            id: row.id,
            code: row.code,
            url: row.url,
            urlSet,
            kycIds,
            moderationIds,
          }),
      )
      .slice(0, limit);

    const incomplete = await tx.mediaAsset.findMany({
      where: {
        deletedAt: null,
        purpose: { in: CLIENT_PURPOSES },
        sizeBytes: 0,
        checksumSha256: null,
        createdAt: { lt: incompleteBefore },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, key: true },
    });

    let softDeleted = 0;
    let incompleteSoftDeleted = 0;

    if (!dryRun && softDelete) {
      const now = new Date();
      if (orphans.length) {
        const res = await tx.mediaAsset.updateMany({
          where: { id: { in: orphans.map((o) => o.id) }, deletedAt: null },
          data: { deletedAt: now },
        });
        softDeleted = res.count;
      }
      if (incomplete.length) {
        const res = await tx.mediaAsset.updateMany({
          where: {
            id: { in: incomplete.map((o) => o.id) },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });
        incompleteSoftDeleted = res.count;
      }
    }

    const purgeRows = await tx.mediaAsset.findMany({
      where: {
        deletedAt: { not: null, lt: purgeBefore },
        purpose: { in: CLIENT_PURPOSES },
      },
      orderBy: { deletedAt: "asc" },
      take: limit,
      select: { id: true, key: true },
    });

    let purged = 0;
    if (!dryRun && purge) {
      const urlSetPurge = await loadReferencedUrls(tx);
      const kycIdsPurge = await loadKycAssetIds(tx);
      const moderationIdsPurge = await loadModerationReferencedIds(tx);

      for (const row of purgeRows) {
        const still = await tx.mediaAsset.findFirst({
          where: { id: row.id },
          select: { id: true, code: true, url: true, deletedAt: true },
        });
        if (!still?.deletedAt) continue;
        if (
          isReferenced({
            id: still.id,
            code: still.code,
            url: still.url,
            urlSet: urlSetPurge,
            kycIds: kycIdsPurge,
            moderationIds: moderationIdsPurge,
          })
        ) {
          await tx.mediaAsset.update({
            where: { id: still.id },
            data: { deletedAt: null },
          });
          continue;
        }
        await deleteObject(row.key);
        await tx.mediaAsset.delete({ where: { id: row.id } });
        purged += 1;
      }
    }

    return {
      dryRun,
      orphanCandidates: orphans.length,
      softDeleted,
      incompleteCandidates: incomplete.length,
      incompleteSoftDeleted,
      purgeCandidates: purgeRows.length,
      purged,
      sampleIds: orphans.slice(0, 10).map((o) => o.id),
    };
  });
}
