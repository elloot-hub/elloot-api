import type { Prisma } from "@prisma/client";
import { AppError } from "../../lib/errors";

export type ReachPlanRow = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  feeBps: number;
  priority: number;
  barLevel: number;
  recommended: boolean;
  sortOrder: number;
};

type Tx = {
  reachPlan: {
    findMany: (args: {
      where?: Prisma.ReachPlanWhereInput;
      orderBy?: Prisma.ReachPlanOrderByWithRelationInput[];
      select?: Prisma.ReachPlanSelect;
    }) => Promise<ReachPlanRow[]>;
    findFirst: (args: {
      where?: Prisma.ReachPlanWhereInput;
      select?: Prisma.ReachPlanSelect;
    }) => Promise<ReachPlanRow | null>;
  };
};

export function serializeReachPlan(row: ReachPlanRow) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    feeBps: row.feeBps,
    feePercent: Math.round((row.feeBps / 100) * 100) / 100,
    priority: row.priority,
    barLevel: row.barLevel,
    recommended: row.recommended,
    sortOrder: row.sortOrder,
  };
}

export async function listActiveReachPlans(tx: Tx) {
  const rows = await tx.reachPlan.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { feeBps: "asc" }],
    select: {
      id: true,
      code: true,
      title: true,
      description: true,
      feeBps: true,
      priority: true,
      barLevel: true,
      recommended: true,
      sortOrder: true,
    },
  });
  return rows.map(serializeReachPlan);
}

export async function resolveReachPlanForListing(
  tx: Tx,
  reachPlanId: string | null | undefined,
) {
  if (!reachPlanId) {
    throw new AppError(
      400,
      "Selecione um plano de alcance",
      "REACH_PLAN_REQUIRED",
    );
  }

  const plan = await tx.reachPlan.findFirst({
    where: { id: reachPlanId, active: true },
    select: {
      id: true,
      code: true,
      title: true,
      description: true,
      feeBps: true,
      priority: true,
      barLevel: true,
      recommended: true,
      sortOrder: true,
    },
  });

  if (!plan) {
    throw new AppError(
      400,
      "Plano de alcance inválido ou inativo",
      "REACH_PLAN_INVALID",
    );
  }

  return plan;
}
