const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

type AuthEmailServiceOptions = {
  sendgridApiKey: string;
  emailFrom: string;
  emailFromName: string;
  exposeAuthCodes: boolean;
};

export type VerificationEmailResult = {
  devVerificationCode?: string;
};

export class AuthEmailService {
  constructor(private readonly options: AuthEmailServiceOptions) {
    // Dev-only escape hatch: returning codes in API responses from the
    // unauthenticated forgot-password endpoint would allow account takeover
    // if the flag ever leaked into a production environment. Refuse it there.
    if (process.env.NODE_ENV === "production" && options.exposeAuthCodes) {
      this.options = { ...options, exposeAuthCodes: false };
    }
  }

  isAvailable() {
    return Boolean(this.options.sendgridApiKey || this.options.exposeAuthCodes);
  }

  async sendRegistrationCode(to: string, code: string): Promise<VerificationEmailResult> {
    return this.sendVerificationCode(
      to,
      code,
      "Your TracyHill RP verification code",
      "Use this code to finish creating your TracyHill RP account.",
    );
  }

  async sendPasswordResetCode(to: string, code: string): Promise<VerificationEmailResult> {
    return this.sendVerificationCode(
      to,
      code,
      "Your TracyHill RP password reset code",
      "Use this code to continue resetting your TracyHill RP password.",
    );
  }

  async sendMfaCode(to: string, code: string): Promise<VerificationEmailResult> {
    return this.sendVerificationCode(
      to,
      code,
      "Your TracyHill RP sign-in code",
      "Use this code to finish signing in to TracyHill RP.",
    );
  }

  async sendAccountDeletionCode(to: string, code: string): Promise<VerificationEmailResult> {
    return this.sendVerificationCode(
      to,
      code,
      "Your TracyHill RP account deletion code",
      "Use this code to continue permanently deleting your TracyHill RP account.",
    );
  }

  private async sendVerificationCode(to: string, code: string, subject: string, intro: string): Promise<VerificationEmailResult> {
    if (this.options.exposeAuthCodes && !this.options.sendgridApiKey) return { devVerificationCode: code };
    if (!this.options.sendgridApiKey) throw new Error("Auth email delivery is not configured");

    const html = `
<div style="background:#0d1117;padding:0;margin:0;width:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117"><tr><td align="center" style="padding:40px 24px">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;width:100%">
    <div style="text-align:center;margin-bottom:28px">
      <span style="font-family:monospace;font-size:24px;font-weight:700;color:#e6edf3">Tracy<span style="color:#3fb950">Hill</span></span>
    </div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;text-align:center">
      <p style="color:#8b949e;font-size:14px;margin:0 0 8px">${intro}</p>
      <div style="font-family:monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#e6edf3;padding:16px 0">${code}</div>
      <p style="color:#8b949e;font-size:13px;margin:16px 0 0">This code expires in 10 minutes.</p>
    </div>
    <p style="color:#8b949e;font-size:12px;text-align:center;margin-top:24px">Don't share this code with anyone. TracyHill RP will never ask for this code.</p>
  </div>
</td></tr></table>
</div>`;
    const text = `${intro} Verification code: ${code}. This code expires in 10 minutes.`;
    const res = await fetch(SENDGRID_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.sendgridApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.options.emailFrom, name: this.options.emailFromName },
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html },
        ],
      }),
    });
    if (!res.ok) {
      const error = await res.text().catch(() => "unknown sendgrid error");
      throw new Error(`SendGrid error ${res.status}: ${error}`);
    }
    return this.options.exposeAuthCodes ? { devVerificationCode: code } : {};
  }
}
