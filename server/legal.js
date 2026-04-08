// ═══════════════════════════════════════════════════════════
// LEGAL PAGES — Privacy Policy & Terms of Service
// ═══════════════════════════════════════════════════════════

const LEGAL_STYLE = `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}body{background:#0d1117;color:#e6edf3;font-family:'DM Sans',sans-serif;line-height:1.7}
.container{max-width:720px;margin:0 auto;padding:48px 24px 80px}
h1{font-family:'JetBrains Mono',monospace;font-size:28px;margin-bottom:8px}h1 span{color:#3fb950}
.subtitle{color:#8b949e;font-size:14px;margin-bottom:40px;font-family:'JetBrains Mono',monospace}
h2{font-family:'JetBrains Mono',monospace;font-size:18px;color:#58a6ff;margin-top:32px;margin-bottom:12px}
h3{font-family:'JetBrains Mono',monospace;font-size:15px;color:#e6edf3;margin-top:24px;margin-bottom:8px}
p,li{font-size:15px;color:#c9d1d9;margin-bottom:12px}
ul{padding-left:24px;margin-bottom:12px}li{margin-bottom:6px}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.divider{border:none;border-top:1px solid #30363d;margin:32px 0}
.back{display:inline-block;margin-bottom:24px;font-size:13px;color:#8b949e;font-family:'JetBrains Mono',monospace}
.back:hover{color:#58a6ff}
@media(max-width:600px){.container{padding:32px 16px 60px}h1{font-size:22px}h2{font-size:16px}}`;

const EFFECTIVE_DATE = "April 2, 2026";

export const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Privacy Policy — TracyHill RP</title>
<style>${LEGAL_STYLE}</style></head><body><div class="container">
<a href="/" class="back">&larr; Back to TracyHill RP</a>
<h1>Tracy<span>Hill</span> RP</h1>
<h1 style="font-size:22px;color:#e6edf3;margin-bottom:4px">Privacy Policy</h1>
<div class="subtitle">Effective: ${EFFECTIVE_DATE}</div>

<p>TracyHill RP ("we," "us," or "the Service") is a privately operated, self-hosted application. This Privacy Policy describes how we collect, use, and protect your information when you use the Service.</p>

<h2>1. Information We Collect</h2>

<h3>Account Information</h3>
<ul>
<li><strong>Username</strong> — chosen at account creation, used for authentication.</li>
<li><strong>Email address</strong> — provided at registration for account verification. Used to send verification codes and account-related notifications.</li>
<li><strong>Password</strong> — stored as a one-way bcrypt hash (cost factor 12). We never store or have access to your plaintext password.</li>
<!-- [SMS REMOVED] <li><strong>Phone number</strong> — provided voluntarily for two-factor authentication (SMS MFA). Stored on the server to send verification codes.</li> -->
</ul>

<h3>Usage Data</h3>
<ul>
<li><strong>Chat conversations</strong> — messages you send and receive through the Service are stored as JSON files on the server to provide session continuity.</li>
<li><strong>API keys</strong> — if you provide your own API keys for AI providers, they are stored server-side in your user data directory with restricted file permissions (mode 600).</li>
<li><strong>Generated images</strong> — images created through the Service are stored on the server.</li>
<li><strong>Campaign and pipeline data</strong> — campaign configurations and pipeline state you create are stored as part of your user data.</li>
</ul>

<h3>Automatically Collected Information</h3>
<ul>
<li><strong>IP address</strong> — logged for rate limiting and security purposes (e.g., brute-force protection). Not used for tracking or analytics.</li>
<li><strong>User agent string</strong> — used solely to label trusted devices in your MFA settings for your convenience.</li>
<li><strong>Session cookies</strong> — we use <code>sf.sid</code> (session) and <code>sf.trust</code> (MFA device trust) cookies. Both are httpOnly, secure, and SameSite. No third-party cookies are used.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<p>We use the information we collect exclusively to:</p>
<ul>
<li>Authenticate you and maintain your session.</li>
<li>Send email verification codes for two-factor authentication.</li>
<li>Store and retrieve your chat sessions, campaigns, and generated content.</li>
<li>Proxy your requests to AI providers (Anthropic, OpenAI, xAI, z.ai, Google) using your API keys.</li>
<li>Protect the Service against unauthorized access, brute-force attacks, and abuse.</li>
</ul>

<h2>3. Third-Party Services</h2>
<p>The Service integrates with the following third-party services:</p>
<ul>
<!-- [SMS REMOVED] <li><strong>Twilio</strong> — to deliver SMS verification codes for MFA. Your phone number is transmitted to Twilio for this purpose. See Twilio's Privacy Policy.</li> -->
<li><strong>Twilio SendGrid</strong> — to deliver email verification codes during registration and account management. Your email address is transmitted to SendGrid for this purpose. See <a href="https://www.twilio.com/en-us/legal/privacy" target="_blank">Twilio's Privacy Policy</a>.</li>
<li><strong>AI Providers</strong> (Anthropic, OpenAI, xAI, z.ai, Google) — your messages are sent to these providers to generate responses, using API keys you provide. Each provider has its own privacy policy governing how it handles API data.</li>
</ul>
<p>We do not use any analytics services, advertising networks, or tracking pixels.</p>

<h2>4. Data Storage and Security</h2>
<ul>
<li>All data is stored on a privately operated, self-hosted server. No data is stored in public cloud databases.</li>
<li>Passwords are hashed with bcrypt. Sensitive files are stored with restricted permissions.</li>
<li>The application enforces HTTPS, HSTS, Content-Security-Policy, and other security headers.</li>
<li>Access is restricted by IP allowlist and firewall rules.</li>
<li>Automated backups are performed at regular intervals.</li>
</ul>

<h2>5. Data Sharing</h2>
<p>We do not sell, rent, or share your personal information with any third parties for marketing or commercial purposes. Data is only transmitted to third-party services as described in Section 3, solely to provide the functionality you request.</p>

<h2>6. Data Retention</h2>
<p>Your data is retained for as long as your account exists. You may request deletion of your account and associated data at any time by contacting the Service administrator. Upon account deletion, all user data files (conversations, API keys, campaigns, and generated images) are permanently removed from the server.</p>

<h2>7. Your Rights</h2>
<p>You may at any time:</p>
<ul>
<li>Access your account information through the application.</li>
<li>Change your password.</li>
<li>Revoke trusted devices from your MFA settings.</li>
<li>Request a copy of your stored data.</li>
<li>Request deletion of your account and all associated data.</li>
</ul>

<h2>8. Children's Privacy</h2>
<p>The Service is not intended for use by individuals under the age of 13. We do not knowingly collect personal information from children under 13.</p>

<h2>9. Changes to This Policy</h2>
<p>We may update this Privacy Policy from time to time. Changes will be reflected by updating the "Effective" date at the top of this page. Continued use of the Service after changes constitutes acceptance of the updated policy.</p>

<h2>10. Contact</h2>
<p>For questions about this Privacy Policy or to exercise your data rights, contact the Service administrator at the email address provided during account setup, or through the application directly.</p>

<hr class="divider">
<p style="color:#8b949e;font-size:12px;font-family:'JetBrains Mono',monospace">&copy; ${new Date().getFullYear()} TracyHill.</p>
</div></body></html>`;

export const TERMS_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Terms of Service — TracyHill RP</title>
<style>${LEGAL_STYLE}</style></head><body><div class="container">
<a href="/" class="back">&larr; Back to TracyHill RP</a>
<h1>Tracy<span>Hill</span> RP</h1>
<h1 style="font-size:22px;color:#e6edf3;margin-bottom:4px">Terms of Service</h1>
<div class="subtitle">Effective: ${EFFECTIVE_DATE}</div>

<p>These Terms of Service ("Terms") govern your use of TracyHill RP ("the Service"), a privately operated, self-hosted application. By accessing or using the Service, you agree to be bound by these Terms.</p>

<h2>1. Eligibility</h2>
<p>You must be at least 13 years of age to use the Service. By creating an account, you represent that you meet this requirement and agree to these Terms.</p>

<h2>2. Account Responsibilities</h2>
<ul>
<li>You are responsible for maintaining the confidentiality of your login credentials.</li>
<li>You are responsible for all activity that occurs under your account.</li>
<li>You must not share your account credentials or MFA verification codes with any other person.</li>
<li>You must notify the Service administrator immediately if you suspect unauthorized access to your account.</li>
<li>Passwords must meet minimum complexity requirements enforced by the Service (minimum 8 characters, including uppercase, lowercase, and a number).</li>
</ul>

<h2>3. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
<li>Attempt to gain unauthorized access to the Service, other user accounts, or the underlying server infrastructure.</li>
<li>Circumvent, disable, or interfere with any security features of the Service.</li>
<li>Use the Service for any unlawful purpose or in violation of any applicable local, state, or federal law.</li>
<li>Attempt to reverse-engineer, decompile, or extract the source code of the Service.</li>
<li>Use automated tools (bots, scrapers) to access the Service without prior authorization.</li>
<li>Intentionally disrupt or overload the Service.</li>
</ul>

<h2>4. API Keys and Third-Party Services</h2>
<ul>
<li>You are solely responsible for any API keys you provide to the Service.</li>
<li>API usage through the Service is subject to the terms and pricing of the respective AI providers (Anthropic, OpenAI, xAI, z.ai, Google).</li>
<li>The Service is not responsible for any charges incurred through your API keys.</li>
<li>You represent that you have the right to use any API keys you configure in the Service.</li>
</ul>

<!-- [SMS REMOVED] Section 5: SMS Two-Factor Authentication removed -->
<h2>5. Two-Factor Authentication</h2>
<ul>
<li>The Service uses email to send verification codes for two-factor authentication.</li>
<li>By creating an account with an email address, you consent to receiving automated verification emails from the Service.</li>
</ul>

<h2>6. Content and Data</h2>
<ul>
<li>You retain ownership of any content you create or input through the Service (conversations, campaigns, prompts).</li>
<li>The Service stores your content solely to provide functionality and does not claim any rights to your content.</li>
<li>AI-generated responses are subject to the terms of the respective AI provider.</li>
<li>You are responsible for the content of your interactions with AI models through the Service.</li>
</ul>

<h2>7. Service Availability</h2>
<p>The Service is provided on a self-hosted, best-effort basis. We do not guarantee any specific uptime or availability. The Service may be temporarily unavailable for maintenance, updates, or due to circumstances beyond our control.</p>

<h2>8. Limitation of Liability</h2>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>
<p>IN NO EVENT SHALL THE SERVICE OPERATOR BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE.</p>

<h2>9. Termination</h2>
<p>We reserve the right to suspend or terminate your access to the Service at any time, with or without cause, with or without notice. Upon termination, your right to use the Service ceases immediately. You may request deletion of your data upon account termination.</p>

<h2>10. Modifications to Terms</h2>
<p>We may revise these Terms at any time by updating this page. Changes take effect immediately upon posting. Your continued use of the Service after any changes constitutes acceptance of the revised Terms.</p>

<h2>11. Governing Law</h2>
<p>These Terms are governed by and construed in accordance with applicable law.</p>

<h2>12. Contact</h2>
<p>For questions about these Terms, contact the Service administrator at the email address provided during account setup, or through the application directly.</p>

<hr class="divider">
<p style="color:#8b949e;font-size:12px;font-family:'JetBrains Mono',monospace">&copy; ${new Date().getFullYear()} TracyHill.</p>
</div></body></html>`;
