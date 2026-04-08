// ═══════════════════════════════════════════════════════════
// EMAIL — SendGrid-based email sending
// ═══════════════════════════════════════════════════════════

const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";
const SENDGRID_KEY = () => process.env.SENDGRID_API_KEY || "";
const EMAIL_FROM = () => process.env.EMAIL_FROM || "noreply@example.com";
const EMAIL_FROM_NAME = () => process.env.EMAIL_FROM_NAME || "TracyHill";

/** Send an email via SendGrid API (no SDK — just fetch) */
export async function sendEmail(to, subject, html, text) {
  const key = SENDGRID_KEY();
  if (!key) throw new Error("SendGrid not configured");

  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: EMAIL_FROM(), name: EMAIL_FROM_NAME() },
    subject,
    content: [],
  };
  if (text) body.content.push({ type: "text/plain", value: text });
  if (html) body.content.push({ type: "text/html", value: html });

  const res = await fetch(SENDGRID_API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "Unknown error");
    throw new Error(`SendGrid error ${res.status}: ${err}`);
  }
}

/** Send a verification code email */
export async function sendVerificationEmail(to, code) {
  const subject = "Your TracyHill verification code";
  const html = `
<div style="background:#0d1117;padding:0;margin:0;width:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117"><tr><td align="center" style="padding:40px 24px">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;width:100%">
    <div style="text-align:center;margin-bottom:28px">
      <span style="font-family:monospace;font-size:24px;font-weight:700;color:#e6edf3">Tracy<span style="color:#3fb950">Hill</span></span>
    </div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;text-align:center">
      <p style="color:#8b949e;font-size:14px;margin:0 0 8px">Your verification code is:</p>
      <div style="font-family:monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#e6edf3;padding:16px 0">${code}</div>
      <p style="color:#8b949e;font-size:13px;margin:16px 0 0">This code expires in 10 minutes.</p>
    </div>
    <p style="color:#8b949e;font-size:12px;text-align:center;margin-top:24px">Don't share this code with anyone. TracyHill will never ask for this code.</p>
    <p style="color:#484f58;font-size:11px;text-align:center;margin-top:16px">If you didn't request this code, you can safely ignore this email.</p>
  </div>
</td></tr></table>
</div>`;
  const text = `Your TracyHill verification code is: ${code}. This code expires in 10 minutes. Don't share this code with anyone. TracyHill will never ask for this code.`;
  await sendEmail(to, subject, html, text);
}

/** Check if email sending is configured */
export function isEmailEnabled() {
  return !!process.env.SENDGRID_API_KEY;
}
