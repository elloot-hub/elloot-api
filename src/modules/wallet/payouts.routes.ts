import { Router } from "express";
import { z } from "zod";
import {
  creditWallet,
  lockWalletUser,
  withRlsTransaction,
  withServiceTransaction,
  type RlsActor,
} from "../../databases";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import { sanitizeUserText } from "../../lib/sanitize";
import { decryptTotpSecret, verifyTotpCode } from "../../lib/totp";
import { requireAuth } from "../../middleware/auth";
import { payoutCreateLimiter } from "../../middleware/rate-limit";
import { createWithPublicCode } from "../../lib/create-with-code";
import { routes } from "../conversations/hrefs";
import { notifyUser } from "../conversations/notifications.notify";
import { userHas2fa } from "../auth/two-factor.shared";

export const payoutsRouter = Router();

function actorOf(req: { user?: RlsActor }): RlsActor {
  return { id: req.user!.id, role: req.user!.role };
}

function formatBrl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

const createPayoutSchema = z.object({
  amountCents: z.number().int().min(500).max(5_000_000),
  pixKey: z.string().trim().min(3).max(140).optional(),
  /** Required when the account has 2FA enabled. */
  totpCode: z.string().trim().min(6).max(12).optional(),
});

payoutsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const payouts = await withRlsTransaction({ actor }, (tx) =>
      tx.payout.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          code: true,
          amountCents: true,
          pixKey: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    res.json({ payouts });
  }),
);

payoutsRouter.post(
  "/",
  requireAuth,
  payoutCreateLimiter,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = createPayoutSchema.parse(req.body);

    const payout = await withServiceTransaction(async (tx) => {
      await lockWalletUser(tx, actor.id);

      const user = await tx.user.findUnique({
        where: { id: actor.id },
        select: {
          id: true,
          pixKey: true,
          kycStatus: true,
          totpSecret: true,
          totpEnabledAt: true,
        },
      });
      if (!user) {
        throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      }

      if (user.kycStatus !== "APPROVED") {
        throw new AppError(
          403,
          "Verifique sua identidade para solicitar saques.",
          "KYC_REQUIRED",
        );
      }

      if (userHas2fa(user)) {
        if (!body.totpCode) {
          throw new AppError(
            403,
            "Confirme o saque com o código 2FA.",
            "2FA_REQUIRED",
          );
        }
        const plain = decryptTotpSecret(user.totpSecret!);
        if (!verifyTotpCode(plain, body.totpCode)) {
          throw new AppError(400, "Código 2FA inválido", "2FA_INVALID_CODE");
        }
      }

      const pixKey =
        body.pixKey !== undefined
          ? sanitizeUserText(body.pixKey, 140)
          : user.pixKey;
      if (!pixKey) {
        throw new AppError(
          400,
          "Cadastre uma chave PIX antes de sacar.",
          "PIX_KEY_REQUIRED",
        );
      }

      const last = await tx.walletLedger.findFirst({
        where: { userId: actor.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { balanceAfter: true },
      });
      const balanceCents = last?.balanceAfter ?? 0;
      if (body.amountCents > balanceCents) {
        throw new AppError(
          400,
          "Saldo insuficiente para este saque.",
          "INSUFFICIENT_BALANCE",
        );
      }

      const pending = await tx.payout.findFirst({
        where: { userId: actor.id, status: "REQUESTED" },
        select: { id: true },
      });
      if (pending) {
        throw new AppError(
          409,
          "Já existe um saque em análise.",
          "PAYOUT_PENDING",
        );
      }

      const created = await createWithPublicCode({
        kind: "PAY",
        create: (code) =>
          tx.payout.create({
            data: {
              code,
              userId: actor.id,
              amountCents: body.amountCents,
              pixKey,
              status: "REQUESTED",
            },
            select: {
              id: true,
              code: true,
              amountCents: true,
              pixKey: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
      });

      await creditWallet(tx, {
        userId: actor.id,
        type: "DEBIT_PAYOUT",
        amountCents: -body.amountCents,
        description: `Saque PIX solicitado (${created.code})`,
      });

      if (body.pixKey !== undefined && body.pixKey !== user.pixKey) {
        await tx.user.update({
          where: { id: actor.id },
          data: { pixKey },
        });
      }

      return created;
    }, actor);

    void notifyUser({
      userId: actor.id,
      type: "SYSTEM",
      title: "Saque solicitado",
      body: `Solicitação de ${formatBrl(payout.amountCents)} enviada. Acompanhe em Saques.`,
      href: routes.dashboardWithdrawals,
      meta: {
        payoutId: payout.id,
        payoutCode: payout.code,
        amountCents: payout.amountCents,
      },
    });

    res.status(201).json({ payout });
  }),
);
