import { defineConfig } from "vitest/config";

/**
 * Покрытие чистых модулей разметки (план 2B.2, ADR-0008): пресеты, сцена, раскладка — не меньше 90 %
 * строк и ветвей. Запуск: npm run coverage.
 */
const STRICT = { lines: 90, branches: 90, functions: 90, statements: 90 };

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/presets.ts", "src/scene/**/*.ts", "src/layout/**/*.ts", "src/store/**/*.ts", "src/render/hit*.ts"],
      exclude: ["src/**/index.ts", "src/**/__tests__/**"],
      reporter: ["text-summary", "text"],
      thresholds: {
        "src/presets.ts": STRICT,
        "src/scene/**/*.ts": STRICT,
        "src/layout/**/*.ts": STRICT,
      },
    },
  },
});
