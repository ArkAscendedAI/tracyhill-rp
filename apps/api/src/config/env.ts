import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ApiEnv = {
  port: number;
  dbFile: string;
  webDistDir: string;
  sessionSecret: string;
  trustProxy: boolean;
  inlineWorkers: boolean;
  seedDemoUser: boolean;
  demoUsername: string;
  demoPassword: string;
  anthropicApiKey: string;
  claudeCodeBridgeUrl: string;
  claudeCodeBridgeSecret: string;
  deepseekApiKey: string;
  googleApiKey: string;
  openaiApiKey: string;
  xaiApiKey: string;
  xiaomiApiKey: string;
  zaiApiKey: string;
  mockProvider: boolean;
  imageDir: string;
  sendgridApiKey: string;
  emailFrom: string;
  emailFromName: string;
  exposeAuthCodes: boolean;
  claudeCodeHost: string;
  claudeCodePort: number;
  claudeCodeSecret: string;
  claudeCodeCaPath: string;
  claudeCodeServername: string;
  codexAgentHost: string;
  codexAgentPort: number;
  codexAgentSecret: string;
  codexAgentCaPath: string;
  codexAgentServername: string;
  allowedIps: string;
  // Comma-separated hostnames that bypass the SSRF private-IP gate on custom endpoint baseUrls.
  // Empty (default) = no exceptions; every custom endpoint must resolve to a public IP.
  customEndpointAllowHosts: string;
};

export function loadEnv(): ApiEnv {
  return {
    port: Number(process.env.PORT ?? 4010),
    dbFile: process.env.DB_FILE ?? path.resolve(process.cwd(), "data/v2/tracyhill-rp-v2.sqlite"),
    webDistDir: process.env.WEB_DIST_DIR ?? path.resolve(process.cwd(), "apps/web/dist"),
    sessionSecret: resolveSessionSecret(),
    trustProxy: process.env.TRUST_PROXY === "true",
    inlineWorkers: process.env.INLINE_WORKERS !== "0",
    seedDemoUser: process.env.SEED_DEMO_USER === "1",
    demoUsername: process.env.DEMO_USERNAME ?? "demo",
    demoPassword: process.env.DEMO_PASSWORD ?? "demo-pass",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    claudeCodeBridgeUrl: process.env.CLAUDE_CODE_BRIDGE_URL ?? "",
    claudeCodeBridgeSecret: process.env.CLAUDE_CODE_BRIDGE_SECRET ?? "",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? "",
    googleApiKey: process.env.GOOGLE_API_KEY ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    xaiApiKey: process.env.XAI_API_KEY ?? "",
    xiaomiApiKey: process.env.XIAOMI_API_KEY ?? "",
    zaiApiKey: process.env.ZAI_API_KEY ?? "",
    mockProvider: process.env.MOCK_PROVIDER === "1",
    imageDir: process.env.IMAGE_DIR ?? path.resolve(process.cwd(), "data/v2/images"),
    sendgridApiKey: process.env.SENDGRID_API_KEY ?? "",
    emailFrom: process.env.EMAIL_FROM ?? "noreply@example.com",
    emailFromName: process.env.EMAIL_FROM_NAME ?? "TracyHill RP",
    exposeAuthCodes: process.env.EXPOSE_AUTH_CODES === "1",
    claudeCodeHost: process.env.CLAUDE_CODE_HOST ?? "",
    claudeCodePort: Number(process.env.CLAUDE_CODE_PORT ?? 7702),
    claudeCodeSecret: process.env.CLAUDE_CODE_SECRET ?? "",
    claudeCodeCaPath: process.env.CLAUDE_CODE_CA_PATH ?? "",
    claudeCodeServername: process.env.CLAUDE_CODE_SERVERNAME ?? "claude-agent",
    codexAgentHost: process.env.CODEX_HOST ?? "",
    codexAgentPort: Number(process.env.CODEX_PORT ?? 7701),
    codexAgentSecret: process.env.CODEX_SECRET ?? "",
    codexAgentCaPath: process.env.CODEX_CA_PATH ?? "",
    codexAgentServername: process.env.CODEX_SERVERNAME ?? "codex-agent",
    allowedIps: process.env.ALLOWED_IPS ?? "",
    customEndpointAllowHosts: process.env.CUSTOM_ENDPOINT_ALLOW_HOSTS ?? "",
  };
}

function resolveSessionSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "test") return "dev-secret-change-me";
  const secretPath = path.resolve(process.cwd(), "data/v2/session.secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf-8").trim();
    if (existing.length >= 32) return existing;
  } catch { /* does not exist yet */ }
  const generated = crypto.randomBytes(48).toString("hex");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}
