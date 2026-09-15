import { z } from "zod";

/** Shared password rules for register / reset (bcrypt max 72). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72;

export const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  )
  .max(
    PASSWORD_MAX_LENGTH,
    `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
  )
  .refine((value) => /[A-Za-zÀ-ÿ]/.test(value) && /\d/.test(value), {
    message: "A senha precisa ter letras e pelo menos um número.",
  });

export function passwordPolicyHint() {
  return `Mínimo ${PASSWORD_MIN_LENGTH} caracteres, com letras e números.`;
}
