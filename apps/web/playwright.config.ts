import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["imported-parity.spec.ts"],
  use: {
    baseURL: "http://127.0.0.1:3010",
  },
  webServer: [
    {
      command: "bash -lc 'tmpdir=$(mktemp -d); export DB_FILE=\"$tmpdir/tracyhill-rp-v2.sqlite\"; export IMAGE_DIR=\"$tmpdir/images\"; mkdir -p \"$IMAGE_DIR\"; export SEED_DEMO_USER=1 DEMO_USERNAME=demo DEMO_PASSWORD=demo-pass MOCK_PROVIDER=1 EXPOSE_AUTH_CODES=1; npm --prefix ../api run dev'",
      url: "http://127.0.0.1:4010/api/system/health",
      reuseExistingServer: false,
    },
    {
      command: "npm --prefix . run dev",
      url: "http://127.0.0.1:3010",
      reuseExistingServer: true,
    },
  ],
});
