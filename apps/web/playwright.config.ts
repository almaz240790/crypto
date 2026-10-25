import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3101",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : undefined,
  },
  webServer: {
    command: "npx next start -p 3101",
    url: "http://localhost:3101/ui",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
