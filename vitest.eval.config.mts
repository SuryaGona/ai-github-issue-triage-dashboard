import {
  fileURLToPath,
} from "node:url";

import {
  defineConfig,
} from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(
        new URL(
          "./src",
          import.meta.url,
        ),
      ),
    },
  },

  test: {
    environment: "node",

    include: [
      "tests/eval/**/*.eval.ts",
    ],

    clearMocks: true,
    restoreMocks: true,

    fileParallelism: false,
    maxWorkers: 1,

    testTimeout: 10_000,
  },
});