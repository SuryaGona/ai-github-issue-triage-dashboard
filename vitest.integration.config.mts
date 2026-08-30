import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const LOCAL_TEST_DATABASE_URL =
  "postgresql://triage:triage_test@127.0.0.1:5436/triage_test";

if (process.env.CI !== "true") {
  process.env.DATABASE_URL = LOCAL_TEST_DATABASE_URL;
}

process.env.GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "integration-test-key";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  test: {
    environment: "node",

    include: [
      "tests/integration/**/*.integration.ts",
    ],

    clearMocks: true,
    restoreMocks: true,

    fileParallelism: false,
    maxWorkers: 1,

    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});