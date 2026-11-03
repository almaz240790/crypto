import { defineConfig } from "vitest/config";

/**
 * Покрытие модулей разметки (план 2B.2, ADR-0008): пресеты, сцена, раскладка, хранилище — не меньше 90 %
 * строк и ветвей; отрисовка и контроллер — в отчёте, примитив и пул меток шкалы — с порогом. Запуск: npm run coverage.
 */
const STRICT = { lines: 90, branches: 90, functions: 90, statements: 90 };

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/presets.ts", "src/scene/**/*.ts", "src/layout/**/*.ts", "src/store/**/*.ts", "src/render/**/*.ts", "src/controller/**/*.ts"],
      exclude: ["src/**/index.ts", "src/**/__tests__/**"],
      reporter: ["text-summary", "text"],
      thresholds: {
        "src/presets.ts": STRICT,
        "src/scene/**/*.ts": STRICT,
        "src/layout/**/*.ts": STRICT,
        "src/store/**/*.ts": STRICT,
        // попадание и пул меток шкалы — в OverlayPrimitive и axisViews
        "src/render/{OverlayPrimitive,axisViews,projector}.ts": { lines: 90, branches: 80, functions: 85, statements: 90 },
      },
    },
  },
});
