import { initDeployment } from "./init";

// Entry point of the `tracyhill-rp-init` Compose service (docker-compose.yml). Paths are the container's.
try {
  initDeployment({
    dataDir: process.env.INIT_DATA_DIR || "/app/data",
    runnerSecretFile: process.env.RUNNER_SECRET_FILE || "/run/tracyhill-secrets/runner.secret",
    env: process.env,
  });
} catch (err) {
  console.error(`[init] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
