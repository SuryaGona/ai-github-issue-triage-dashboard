import { defineConfig, devices } from "@playwright/test";

const LOCAL_TEST_DATABASE_URL =
  "postgresql://triage:triage_test@127.0.0.1:5436/triage_test";

const isCI = process.env.CI === "true";

const databaseUrl = isCI
  ? process.env.DATABASE_URL
  : LOCAL_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set when Playwright runs in CI.",
  );
}

process.env.DATABASE_URL = databaseUrl;
process.env.GEMINI_API_KEY = "e2e-test-key";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",

  outputDir: "node_modules/.cache/playwright-test-results",

  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,

  reporter: "list",

  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],

  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: databaseUrl,
      GEMINI_API_KEY: "e2e-test-key",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});