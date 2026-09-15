import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "../config/env";

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  if (!env.smtpEnabled) {
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.smtpSecure,
    auth: {
      user: env.SMTP_USER!,
      pass: env.SMTP_PASS!,
    },
  });
  return transporter;
}

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendMail(input: SendMailInput): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) return false;

  await tx.sendMail({
    from: env.SMTP_FROM,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  return true;
}

export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
}): Promise<boolean> {
  const subject = "Redefinir senha — Elloot";
  const text = [
    "Você pediu para redefinir a senha da Elloot.",
    "",
    `Abra este link (válido por 1 hora):`,
    input.resetUrl,
    "",
    "Se você não pediu isso, ignore este e-mail.",
  ].join("\n");

  const html = `
    <p>Você pediu para redefinir a senha da <strong>Elloot</strong>.</p>
    <p><a href="${input.resetUrl}">Clique aqui para criar uma nova senha</a></p>
    <p style="color:#666;font-size:13px">O link expira em 1 hora. Se você não pediu isso, ignore este e-mail.</p>
  `.trim();

  return sendMail({ to: input.to, subject, text, html });
}
