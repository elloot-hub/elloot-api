import bcrypt from "bcryptjs";

/**
 * Fixed bcrypt hash used when the account does not exist / has no password,
 * so login timing stays closer to a real compare (anti-enumeration).
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$12$XbEpd3HBIAgeNFPuc8Y6xetTpCeePZcyYTDPEUYWgEsAK6huN80qq";

export async function safePasswordCompare(
  password: string,
  passwordHash: string | null | undefined,
): Promise<boolean> {
  const hash = passwordHash || DUMMY_PASSWORD_HASH;
  const ok = await bcrypt.compare(password, hash);
  // If we used the dummy hash, always fail regardless of compare result.
  if (!passwordHash) return false;
  return ok;
}
