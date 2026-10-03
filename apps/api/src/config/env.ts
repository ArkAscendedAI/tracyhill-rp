import path from "node:path";

import { resolveCodexAgentConnection, resolveRunnerConnection } from "@tracyhill-rp/provider-runtime";

import { loadOrCreateSessionSecret, sessionSecretPath } from "./sessionSecret";

export type ApiEnv = {
  port: number;
  dbFile: string;
  webDistDir: string;
  sessionSecret: string;
  /** Any proxy trust configured: Secure cookies + HSTS switch on with it. */
  trustProxy: boolean;
  /** What Express `trust proxy` receives when trustProxy is on: a hop count or
   *  a trusted address / subnet / preset list (see parseTrustProxy). */
  trustProxySetting: number | string | false;
  inlineWorkers: boolean;
  /** Run per-turn retrieval scoring on a worker thread (default). "0" keeps it on the API thread. */
  contextScoringWorker: boolean;
  seedDemoUser: boolean;
  demoUsername: string;
  demoPassword: string;
  anthropicApiKey: string;
  // Subscription runner (2026-09-25): RUNNER_URL defaults to the Compose service; the
  // secret is RUNNER_SECRET or derived from the session secret (provider-runtime).
  runnerUrl: string;
  runnerSecret: string;
  deepseekApiKey: string;
  fireworksApiKey: string;
  gmicloudApiKey: string;
  googleApiKey: string;
  moonshotApiKey: string;
  openaiApiKey: string;
  xaiApiKey: string;
  xiaomiApiKey: string;
  zaiApiKey: string;
  // Optional server-level OpenAI-compatible embeddings endpoint (Ollama/TEI/etc.)
  // that backs `local:` embedding models. Dormant unless set.
  localEmbeddingUrl: string;
  localEmbeddingKey: string;
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
  kimiCodeHost: string;
  kimiCodePort: number;
  kimiCodeSecret: string;
  kimiCodeCaPath: string;
  kimiCodeServername: string;
  allowedIps: string;
  // Comma-separated hostnames that bypass the SSRF private-IP gate on custom endpoint baseUrls.
  // Empty (default) = no exceptions; every custom endpoint must resolve to a public IP.
  customEndpointAllowHosts: string;
};

/**
 * Empty string == unset. Compose renders
 * `${VAR:-}` as "" and `env_file` passes `KIMI_CODE_PORT=` through verbatim,
 * so `??` alone kept the empty string: `Number("")` is 0 — port 0 — and an
 * empty host/secret/path skipped its default. Trim, then fall back.
 */
export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  return value === "" ? fallback : value;
}

export function envNumber(name: string, fallback: number): number {
  const raw = envString(name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * TRUST_PROXY. Only the literal "true"
 * used to count; `1`, `TRUE` or `yes` — the convention every neighbouring flag
 * uses — silently left Secure cookies, HSTS and proxy trust OFF, so `req.ip`
 * was the proxy's address and every per-IP auth budget was shared by the whole
 * internet. Accepted now, case-insensitively:
 *   - `1` / `true` / `yes` / `on`  → one trusted hop (Express `trust proxy` = 1)
 *   - `0` / `false` / `no` / `off` / unset → off
 *   - an integer ≥ 2 → that many trusted hops (an edge proxy chained through
 *     the internal one is TWO hops; with one hop Express reads the edge
 *     proxy's address as every external client's `req.ip`)
 *   - anything else → passed to Express verbatim as its trusted address /
 *     subnet / preset list (`loopback, 192.168.1.10`). Express compiles that
 *     list at `app.set` time and throws on an invalid entry, so a typo fails
 *     the boot loudly instead of silently trusting nothing.
 */
export function parseTrustProxy(raw: string | undefined): number | string | false {
  const value = raw?.trim() ?? "";
  if (value === "") return false;
  const lower = value.toLowerCase();
  if (["0", "false", "no", "off"].includes(lower)) return false;
  if (["1", "true", "yes", "on"].includes(lower)) return 1;
  if (/^\d+$/.test(lower)) return Number(lower);
  return value;
}

/** process.env with empty-string entries removed, for readers that use `??`. */
function envWithoutEmpties(): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value;
  }
  return cleaned;
}

export function loadEnv(): ApiEnv {
  const trustProxySetting = parseTrustProxy(process.env.TRUST_PROXY);
  const sessionSecret = resolveSessionSecret();
  const runner = resolveRunnerConnection({ ...process.env, SESSION_SECRET: sessionSecret });
  return {
    runnerUrl: runner.runnerUrl,
    runnerSecret: runner.runnerSecret,
    port: envNumber("PORT", 4010),
    dbFile: envString("DB_FILE", path.resolve(process.cwd(), "data/v2/tracyhill-rp-v2.sqlite")),
    webDistDir: envString("WEB_DIST_DIR", path.resolve(process.cwd(), "apps/web/dist")),
    sessionSecret,
    trustProxy: trustProxySetting !== false,
    trustProxySetting,
    inlineWorkers: process.env.INLINE_WORKERS !== "0",
    contextScoringWorker: process.env.CONTEXT_SCORING_WORKER !== "0",
    seedDemoUser: process.env.SEED_DEMO_USER === "1",
    demoUsername: envString("DEMO_USERNAME", "demo"),
    demoPassword: envString("DEMO_PASSWORD", "demo-pass"),
    anthropicApiKey: envString("ANTHROPIC_API_KEY", ""),
    deepseekApiKey: envString("DEEPSEEK_API_KEY", ""),
    fireworksApiKey: envString("FIREWORKS_API_KEY", ""),
    gmicloudApiKey: envString("GMICLOUD_API_KEY", ""),
    googleApiKey: envString("GOOGLE_API_KEY", ""),
    moonshotApiKey: envString("MOONSHOT_API_KEY", ""),
    openaiApiKey: envString("OPENAI_API_KEY", ""),
    xaiApiKey: envString("XAI_API_KEY", ""),
    xiaomiApiKey: envString("XIAOMI_API_KEY", ""),
    zaiApiKey: envString("ZAI_API_KEY", ""),
    localEmbeddingUrl: envString("LOCAL_EMBEDDING_URL", ""),
    localEmbeddingKey: envString("LOCAL_EMBEDDING_KEY", ""),
    mockProvider: process.env.MOCK_PROVIDER === "1",
    imageDir: envString("IMAGE_DIR", path.resolve(process.cwd(), "data/v2/images")),
    sendgridApiKey: envString("SENDGRID_API_KEY", ""),
    // Raw ("" when unset): a value here wins over Admin: Server settings and shows locked there, so
    // the settings service applies the defaults itself.
    emailFrom: envString("EMAIL_FROM", ""),
    emailFromName: envString("EMAIL_FROM_NAME", ""),
    exposeAuthCodes: process.env.EXPOSE_AUTH_CODES === "1",
    claudeCodeHost: envString("CLAUDE_CODE_HOST", ""),
    claudeCodePort: envNumber("CLAUDE_CODE_PORT", 7702),
    claudeCodeSecret: envString("CLAUDE_CODE_SECRET", ""),
    claudeCodeCaPath: envString("CLAUDE_CODE_CA_PATH", ""),
    claudeCodeServername: envString("CLAUDE_CODE_SERVERNAME", "claude-agent"),
    kimiCodeHost: envString("KIMI_CODE_HOST", ""),
    kimiCodePort: envNumber("KIMI_CODE_PORT", 7704),
    kimiCodeSecret: envString("KIMI_CODE_SECRET", ""),
    kimiCodeCaPath: envString("KIMI_CODE_CA_PATH", ""),
    kimiCodeServername: envString("KIMI_CODE_SERVERNAME", "kimi-agent"),
    // provider-runtime reads CODEX_* with `??`; hand it an env with the empty
    // strings removed so `CODEX_PORT=` cannot become port 0 there either.
    ...resolveCodexAgentConnection(envWithoutEmpties()),
    allowedIps: envString("ALLOWED_IPS", ""),
    customEndpointAllowHosts: envString("CUSTOM_ENDPOINT_ALLOW_HOSTS", ""),
  };
}

// An operator's SESSION_SECRET wins; otherwise the deployment's stored one (written by the Docker init service
// before this process starts); a bare-node API with neither generates and stores it (config/sessionSecret.ts).
function resolveSessionSecret(): string {
  const configured = envString("SESSION_SECRET", "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "test") return "dev-secret-change-me";
  return loadOrCreateSessionSecret(sessionSecretPath());
}
