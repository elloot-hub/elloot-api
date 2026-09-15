import type { PublicCodeKind } from "./public-codes";
import { generatePublicCode } from "./public-codes";

type PrismaUniqueError = { code?: string };

export async function createWithPublicCode<T>(input: {
  kind: PublicCodeKind;
  create: (code: string) => Promise<T>;
  maxAttempts?: number;
}): Promise<T> {
  const max = input.maxAttempts ?? 8;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await input.create(generatePublicCode(input.kind));
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as PrismaUniqueError).code)
          : "";
      if (code !== "P2002" || attempt === max - 1) throw err;
    }
  }
  throw new Error(`Could not allocate ${input.kind} public code`);
}
