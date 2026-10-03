import { useState } from "react";

import type { TotpSetup } from "@tracyhill-rp/contracts";

// The parts of authenticator setup the sign-in setup page and the account dialog share.

/** The QR code, the key to type, and on a phone a link that opens the authenticator app. */
export function TotpSetupBlock({ setup }: { setup: TotpSetup }) {
  return (
    <div className="totp-setup">
      <img className="totp-qr" src={setup.qrSvgDataUrl} alt="QR code for your authenticator app" width={176} height={176} />
      <div className="totp-setup-text">
        <p className="muted small-copy">Scan the code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy or any other). On this phone, tap the link instead. Or type the key.</p>
        <a className="totp-open-link" href={setup.otpauthUri}>Open in authenticator app</a>
        <p className="totp-key" aria-label="Authenticator key"><code>{setup.key}</code></p>
      </div>
    </div>
  );
}

/** Recovery codes, shown once, with a copy button; the caller decides what "done" does. */
export function RecoveryCodesBlock({ codes, onDone, doneLabel }: { codes: string[]; onDone: () => void; doneLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack stack-tight">
      <p className="small-copy">Save these recovery codes somewhere safe, such as a password manager or a printed page. Each one signs you in once if you lose your phone. They are not shown again.</p>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((code) => <li key={code}><code>{code}</code></li>)}
      </ol>
      <div className="row gap-sm wrap-row">
        <button
          type="button"
          className="secondary-button"
          onClick={() => { void navigator.clipboard?.writeText(codes.join("\n")).then(() => setCopied(true), () => setCopied(false)); }}
        >
          {copied ? "Copied" : "Copy codes"}
        </button>
        <button type="button" onClick={onDone}>{doneLabel}</button>
      </div>
    </div>
  );
}
