import nodemailer from "nodemailer";

import type { SmtpSecurity } from "@tracyhill-rp/contracts";

// How the server sends email: SendGrid's HTTP API, or any SMTP server. The settings service decides which
// one applies (the environment's SENDGRID_API_KEY wins over the page's settings) and hands a resolved config here.

const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";
const SMTP_TIMEOUT_MS = 15_000;

export type EmailTransportConfig =
  | { kind: "sendgrid"; apiKey: string; fromAddress: string; fromName: string }
  | { kind: "smtp"; host: string; port: number; security: SmtpSecurity; username: string; password: string; fromAddress: string; fromName: string };

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export async function sendEmail(config: EmailTransportConfig, message: EmailMessage): Promise<void> {
  if (config.kind === "sendgrid") {
    const res = await fetch(SENDGRID_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: config.fromAddress, name: config.fromName },
        subject: message.subject,
        content: [
          { type: "text/plain", value: message.text },
          { type: "text/html", value: message.html },
        ],
      }),
      signal: AbortSignal.timeout(SMTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      const error = await res.text().catch(() => "unknown sendgrid error");
      throw new Error(`SendGrid error ${res.status}: ${error}`);
    }
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // "tls": TLS from the first byte (usually port 465). "starttls": plain, then upgrade, and refuse to send if the
    // server cannot upgrade (usually 587). "none": no encryption, for a relay on a trusted network.
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from: config.fromName ? { name: config.fromName, address: config.fromAddress } : config.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } finally {
    transport.close();
  }
}
