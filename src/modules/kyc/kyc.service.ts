import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { sanitizeUserText } from "../../lib/sanitize";

type Tx = Prisma.TransactionClient;

export function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

export function isValidCpf(raw: string): boolean {
  const cpf = digitsOnly(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) {
      sum += Number(cpf[i]) * (len + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export function formatCpfMasked(digits: string) {
  const cpf = digitsOnly(digits);
  if (cpf.length !== 11) return "•••";
  return `***.${cpf.slice(3, 6)}.***-${cpf.slice(9)}`;
}

export function serializeSubmission(row: {
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
}) {
  return {
    id: row.id,
    fullName: row.fullName,
    documentMasked: formatCpfMasked(row.documentNumber),
    status: row.status,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    hasDocuments: true,
  };
}

async function assertOwnedImage(
  tx: Tx,
  assetId: string,
  ownerId: string,
  label: string,
) {
  const asset = await tx.mediaAsset.findFirst({
    where: { id: assetId, ownerId, deletedAt: null },
    select: { id: true, mimeType: true },
  });
  if (!asset) {
    throw new AppError(
      400,
      `Imagem inválida: ${label}`,
      "KYC_MEDIA_INVALID",
    );
  }
  if (!asset.mimeType.startsWith("image/")) {
    throw new AppError(400, `Arquivo inválido: ${label}`, "KYC_MEDIA_TYPE");
  }
}

export async function getMyKyc(tx: Tx, userId: string) {
  const [user, submission] = await Promise.all([
    tx.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true,
        emailVerifiedAt: true,
        phone: true,
        phoneVerifiedAt: true,
      },
    }),
    tx.kycSubmission.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    kycStatus: user?.kycStatus ?? "NONE",
    emailVerified: Boolean(user?.emailVerifiedAt),
    phone: user?.phone ?? null,
    phoneVerified: Boolean(user?.phoneVerifiedAt),
    submission: submission ? serializeSubmission(submission) : null,
  };
}

export async function submitKyc(
  tx: Tx,
  input: {
    userId: string;
    fullName: string;
    documentNumber: string;
    frontAssetId: string;
    backAssetId: string;
    selfieAssetId: string;
  },
) {
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { id: true, kycStatus: true },
  });
  if (!user) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  if (user.kycStatus === "APPROVED") {
    throw new AppError(409, "Documentos já verificados", "KYC_ALREADY_APPROVED");
  }
  if (user.kycStatus === "PENDING") {
    throw new AppError(
      409,
      "Já existe uma verificação em análise",
      "KYC_ALREADY_PENDING",
    );
  }

  const fullName = sanitizeUserText(input.fullName, 80);
  if (fullName.length < 3) {
    throw new AppError(400, "Informe o nome completo", "KYC_NAME_INVALID");
  }

  const documentNumber = digitsOnly(input.documentNumber);
  if (!isValidCpf(documentNumber)) {
    throw new AppError(400, "CPF inválido", "KYC_CPF_INVALID");
  }

  const ids = [
    input.frontAssetId,
    input.backAssetId,
    input.selfieAssetId,
  ];
  if (new Set(ids).size !== 3) {
    throw new AppError(
      400,
      "Envie três fotos diferentes (frente, verso e selfie)",
      "KYC_MEDIA_DUPLICATE",
    );
  }

  await assertOwnedImage(tx, input.frontAssetId, input.userId, "frente do documento");
  await assertOwnedImage(tx, input.backAssetId, input.userId, "verso do documento");
  await assertOwnedImage(tx, input.selfieAssetId, input.userId, "selfie");

  const submission = await tx.kycSubmission.create({
    data: {
      userId: input.userId,
      fullName,
      documentNumber,
      frontAssetId: input.frontAssetId,
      backAssetId: input.backAssetId,
      selfieAssetId: input.selfieAssetId,
      status: "PENDING",
    },
  });

  await tx.user.update({
    where: { id: input.userId },
    data: { kycStatus: "PENDING" },
  });

  return serializeSubmission(submission);
}
