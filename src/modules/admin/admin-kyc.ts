import type { Prisma } from "@prisma/client";
import { formatCpfMasked, digitsOnly } from "../kyc/kyc.service";
import { issueSignedUrl } from "../media/media.service";

type Tx = Prisma.TransactionClient;

export function formatCpfDisplay(raw: string) {
  const cpf = digitsOnly(raw);
  if (cpf.length !== 11) return raw;
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
}

async function resolveDocUrl(
  tx: Tx,
  assetId: string,
): Promise<string | null> {
  const asset = await tx.mediaAsset.findFirst({
    where: { id: assetId, deletedAt: null },
    select: { id: true, code: true, url: true, visibility: true },
  });
  if (!asset) return null;
  if (asset.visibility === "PUBLIC") return asset.url;
  return issueSignedUrl({ id: asset.id, code: asset.code }).url;
}

export async function serializeAdminKycSubmission(
  tx: Tx,
  row: {
    id: string;
    fullName: string;
    documentNumber: string;
    frontAssetId: string;
    backAssetId: string;
    selfieAssetId: string;
    status: string;
    reviewNote: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
  },
) {
  const [frontUrl, backUrl, selfieUrl] = await Promise.all([
    resolveDocUrl(tx, row.frontAssetId),
    resolveDocUrl(tx, row.backAssetId),
    resolveDocUrl(tx, row.selfieAssetId),
  ]);

  return {
    id: row.id,
    fullName: row.fullName,
    documentNumber: formatCpfDisplay(row.documentNumber),
    documentMasked: formatCpfMasked(row.documentNumber),
    status: row.status,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    documents: {
      front: { assetId: row.frontAssetId, url: frontUrl },
      back: { assetId: row.backAssetId, url: backUrl },
      selfie: { assetId: row.selfieAssetId, url: selfieUrl },
    },
  };
}

export type AdminKycSubmission = Awaited<
  ReturnType<typeof serializeAdminKycSubmission>
>;
