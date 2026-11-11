import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3101",
    locale: "ru-RU",
    viewport: { width: 1600, height: 900 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : undefined,
  },
  webServer: [
    {
      command: "node e2e/mock-api.mjs",
      url: "http://localhost:8099/health",
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: "npx next start -p 3101",
      url: "http://localhost:3101/ui",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_URL: "http://localhost:8099" },
    },
    // Сигналы закрыты, как в бою сейчас (ADR-0013): свой экземпляр заглушки API и своя сборка сайта на нём —
    // для e2e/signals.closed.spec.ts (у остальных спеков заглушка с открытыми сигналами, как до решения).
    {
      command: "node e2e/mock-api.mjs",
      url: "http://localhost:8098/health",
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: { MOCK_PORT: "8098", MOCK_SIGNALS: "closed" },
    },
    {
      command: "npx next start -p 3111",
      url: "http://localhost:3111/ui",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { API_URL: "http://localhost:8098" },
    },
  ],
});
