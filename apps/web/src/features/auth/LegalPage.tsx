import { FullscreenCenter } from "../../shared/ui/FullscreenCenter";

type LegalPageProps = {
  kind: "terms" | "privacy";
};

const TERMS_COPY = {
  eyebrow: "Terms Of Service",
  title: "TracyHill RP Terms",
  updated: "Updated for the current private preview.",
  sections: [
    {
      heading: "Use Of The Service",
      body: "TracyHill RP is a private multi-user fiction and roleplay client. Access is limited to authorized users. You are responsible for activity that occurs under your account and for keeping your credentials private.",
    },
    {
      heading: "Provider Usage",
      body: "Messages and attached content may be sent to configured AI providers to generate responses or images. Provider availability, pricing, and provider-side policy handling remain outside the control of this app.",
    },
    {
      heading: "Termination",
      body: "Access may be suspended or revoked at any time. The service supports self-service password change, email-backed MFA, remembered devices, registration verification, forgot-password reset, and staged account deletion.",
    },
  ],
};

const PRIVACY_COPY = {
  eyebrow: "Privacy Policy",
  title: "TracyHill RP Privacy",
  updated: "Updated for the current private preview.",
  sections: [
    {
      heading: "What The App Stores",
      body: "The service stores account credentials, session metadata, messages, attachments, generated images, campaign data, and related operational records needed to run the product.",
    },
    {
      heading: "How Data Is Used",
      body: "Stored data is used to authenticate users, render the workspace, persist long-form conversations, run campaign and wizard workflows, and recover in-flight activity such as interrupted chat streams.",
    },
    {
      heading: "Provider And Operator Access",
      body: "Configured AI providers receive request content needed to fulfill chat or image operations. Administrators may access persisted data for maintenance, support, security review, or recovery work inside this private deployment.",
    },
  ],
};

export function LegalPage({ kind }: LegalPageProps) {
  const copy = kind === "terms" ? TERMS_COPY : PRIVACY_COPY;
  return (
    <FullscreenCenter>
      <section className="card stack">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className="muted">{copy.updated}</p>
        </div>
        {copy.sections.map((section) => (
          <section key={section.heading} className="stack stack-tight">
            <h2>{section.heading}</h2>
            <p className="muted">{section.body}</p>
          </section>
        ))}
        <div className="row gap-sm end">
          <a href="/" className="secondary-button" style={{ textDecoration: "none" }}>Back To Login</a>
        </div>
      </section>
    </FullscreenCenter>
  );
}
