import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
