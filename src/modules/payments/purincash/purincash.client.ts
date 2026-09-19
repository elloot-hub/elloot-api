import { env } from "../../../config/env";
import { AppError } from "../../../lib/errors";

export type PurinCashCustomer = {
  name?: string;
  email?: string;
  externalId?: string;
};

export type CreatePurinCashChargeInput = {
  valueCents: number;
  description: string;
  expiresIn: number;
  callbackUrl: string;
  customer?: PurinCashCustomer;
  metadata?: string;
};

export type PurinCashCharge = {
  paymentId: string;
  status: string;
  amountCents: number;
  currency?: string;
  environment?: string;
  pix?: {
    brCode?: string;
    qrCodeImage?: string | null;
  };
  expiresAt?: string;
};

type PurinCashErrorBody = {
  error?: string;
};

function apiBase() {
  return env.PURINCASH_API_BASE.replace(/\/$/, "");
}

function authHeaders() {
  const key = env.PURINCASH_API_KEY?.trim();
  if (!key) {
    throw new AppError(
      500,
      "PurinCash API key is not configured",
      "PURINCASH_MISCONFIGURED",
    );
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError(
      502,
      "PurinCash returned invalid JSON",
      "PURINCASH_BAD_RESPONSE",
    );
  }
}

function throwPurinCashHttp(status: number, body: PurinCashErrorBody) {
  const message =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : `PurinCash request failed (${status})`;
  if (status === 401 || status === 403) {
    throw new AppError(502, message, "PURINCASH_UNAUTHORIZED");
  }
  if (status === 400) {
    throw new AppError(400, message, "PURINCASH_BAD_REQUEST");
  }
  throw new AppError(502, message, "PURINCASH_UPSTREAM");
}

export async function createPurinCashCharge(
  input: CreatePurinCashChargeInput,
): Promise<PurinCashCharge> {
  const res = await fetch(`${apiBase()}/v1/charges`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(input),
  });
  const body = await parseJson<PurinCashCharge & PurinCashErrorBody>(res);
  if (!res.ok) throwPurinCashHttp(res.status, body);
  if (!body.paymentId) {
    throw new AppError(
      502,
      "PurinCash did not return paymentId",
      "PURINCASH_BAD_RESPONSE",
    );
  }
  return body;
}

export async function getPurinCashCharge(
  paymentId: string,
): Promise<PurinCashCharge> {
  const res = await fetch(
    `${apiBase()}/v1/charges/${encodeURIComponent(paymentId)}`,
    {
      method: "GET",
      headers: authHeaders(),
    },
  );
  const body = await parseJson<PurinCashCharge & PurinCashErrorBody>(res);
  if (!res.ok) throwPurinCashHttp(res.status, body);
  return body;
}
