import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shared CI runners (especially Windows) can stall SQLite-heavy scheduler
    // tests past the 5s default; local runs keep the tight timeout.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    coverage: {
      exclude: [
        "coverage/**",
        "dist/**",
        "node_modules/**",
        "scripts/**",
        "src/scripts/**",
        "test/**",
        "vitest.config.ts",
        "**/*.d.ts",
      ],
    },
  },
});
