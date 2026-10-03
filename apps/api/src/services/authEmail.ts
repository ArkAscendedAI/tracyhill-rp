import { sendEmail, type EmailMessage, type EmailTransportConfig } from "./emailTransport";

// The fixed options of the original setup (and of the unit tests): SendGrid from the environment.
type StaticOptions = {
  sendgridApiKey: string;
  emailFrom: string;
  emailFromName: string;
  exposeAuthCodes: boolean;
};

// The settings service supplies the transport (the environment's SendGrid key wins over the page's
// settings) and says whether email works: configured in the environment, or a test email succeeded with the current
// settings. Read on every send, so a change in Admin: Server settings applies without a restart.
type DynamicOptions = {
  exposeAuthCodes: boolean;
  transport: () => EmailTransportConfig | null;
  working: () => boolean;
};

export type VerificationEmailResult = {
  devVerificationCode?: string;
};

export class AuthEmailService {
  private readonly exposeAuthCodes: boolean;
  private readonly transport: () => EmailTransportConfig | null;
  private readonly working: () => boolean;

  constructor(options: StaticOptions | DynamicOptions) {
    // Dev-only escape hatch: returning codes in API responses from the
    // unauthenticated forgot-password endpoint would allow account takeover
    // if the flag ever leaked into a production environment. Refuse it there.
    this.exposeAuthCodes = process.env.NODE_ENV === "production" ? false : options.exposeAuthCodes;
    if ("transport" in options) {
      this.transport = options.transport;
      this.working = options.working;
    } else {
      const config: EmailTransportConfig | null = options.sendgridApiKey
        ? { kind: "sendgrid", apiKey: options.sendgridApiKey, fromAddress: options.emailFrom, fromName: options.emailFromName }
        : null;
      this.transport = () => config;
      this.working = () => config !== null;
    }
  }

  isAvailable() {
    return this.working() || this.exposeAuthCodes;
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

  async sendEmailChangeCode(to: string, code: string): Promise<VerificationEmailResult> {
    return this.sendVerificationCode(
      to,
      code,
      "Your TracyHill RP email verification code",
      "Use this code to confirm this address for your TracyHill RP account.",
    );
  }

  private async sendVerificationCode(to: string, code: string, subject: string, intro: string): Promise<VerificationEmailResult> {
    const transport = this.working() ? this.transport() : null;
    if (this.exposeAuthCodes && !transport) return { devVerificationCode: code };
    if (!transport) throw new Error("Auth email delivery is not configured");
    await sendEmail(transport, verificationMessage(to, code, subject, intro));
    return this.exposeAuthCodes ? { devVerificationCode: code } : {};
  }
}

/** The test email from Admin: Server settings, sent through settings that are not proven yet. */
export async function sendTestEmail(transport: EmailTransportConfig, to: string): Promise<void> {
  await sendEmail(transport, {
    to,
    subject: "TracyHill RP test email",
    text: "This is a test email from TracyHill RP. If you can read it, the server can send email.",
    html: frame("<p style=\"color:#e6edf3;font-size:15px;margin:0\">This is a test email from TracyHill RP.</p><p style=\"color:#8b949e;font-size:13px;margin:12px 0 0\">If you can read it, the server can send email.</p>"),
  });
}

function verificationMessage(to: string, code: string, subject: string, intro: string): EmailMessage {
  return {
    to,
    subject,
    text: `${intro} Verification code: ${code}. This code expires in 10 minutes.`,
    html: frame(`<p style="color:#8b949e;font-size:14px;margin:0 0 8px">${intro}</p>
      <div style="font-family:monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:#e6edf3;padding:16px 0">${code}</div>
      <p style="color:#8b949e;font-size:13px;margin:16px 0 0">This code expires in 10 minutes.</p>`, true),
  };
}

function frame(inner: string, withWarning = false) {
  return `
<div style="background:#0d1117;padding:0;margin:0;width:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117"><tr><td align="center" style="padding:40px 24px">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;width:100%">
    <div style="text-align:center;margin-bottom:28px">
      <span style="font-family:monospace;font-size:24px;font-weight:700;color:#e6edf3">Tracy<span style="color:#3fb950">Hill</span></span>
    </div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;text-align:center">
      ${inner}
    </div>
    ${withWarning ? '<p style="color:#8b949e;font-size:12px;text-align:center;margin-top:24px">Don\'t share this code with anyone. TracyHill RP will never ask for this code.</p>' : ""}
  </div>
</td></tr></table>
</div>`;
}
