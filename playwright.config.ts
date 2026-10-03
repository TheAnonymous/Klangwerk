import { defineConfig, devices } from "@playwright/test";

const port = Number.parseInt(process.env.KLANGWERK_E2E_PORT ?? "4410", 10);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}/` },
  webServer: {
    command: `npx vite --config e2e/harness/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } } }],
});
