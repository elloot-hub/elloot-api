import { env } from "../../config/env";

export type PaymentMethodDto = {
  id: "pix" | "card";
  label: string;
  hint: string;
  available: boolean;
  provider?: "sandbox" | "efi" | "purincash" | null;
};

export function listPaymentMethods() {
  const pixProvider =
    env.PAYMENT_PROVIDER === "efi"
      ? "efi"
      : env.PAYMENT_PROVIDER === "purincash"
        ? "purincash"
        : "sandbox";

  const methods: PaymentMethodDto[] = [
    {
      id: "pix",
      label: "PIX",
      hint: "Aprovação na hora",
      available: true,
      provider: pixProvider,
    },
    {
      id: "card",
      label: "Cartão",
      hint: "Em breve",
      available: false,
      provider: null,
    },
  ];

  return {
    provider: env.PAYMENT_PROVIDER,
    methods,
  };
}
