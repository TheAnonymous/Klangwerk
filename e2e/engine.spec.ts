import { expect, test } from "@playwright/test";

interface Harness {
  renderTwice(seconds: number): Promise<{ peak: number; rmsDb: number; nonFinite: number; digest: string; steps: number; difference: number }>;
  clockTicks(ms: number): Promise<number>;
  record(ms: number): Promise<{ frames: number; peak: number }>;
  violations: string[];
}

declare global {
  interface Window {
    klangwerk: Harness;
  }
}

const pageErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("./");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "1");
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.klangwerk.violations)).toEqual([]);
});

test("a song through voices, buses, effects and master: loud, never clipping, the same every time", async ({ page }) => {
  const song = await page.evaluate(() => window.klangwerk.renderTwice(6));
  expect(song.nonFinite).toBe(0);
  expect(song.peak).toBeLessThanOrEqual(0.98);
  expect(song.peak).toBeGreaterThan(0.3);
  expect(song.rmsDb).toBeGreaterThan(-20);
  expect(song.steps).toBe(48);
  // Not to the bit: Chromium sums a node's inputs in no fixed order, which leaves rounding noise far below hearing.
  expect(song.difference).toBeLessThan(1e-5);
});

test("the clock ticks from its Blob worker under the production CSP", async ({ page }) => {
  const ticks = await page.evaluate(() => window.klangwerk.clockTicks(400));
  expect(ticks).toBeGreaterThan(8);
});

test("the recorder's Blob worklet records the master under the production CSP", async ({ page }) => {
  const recording = await page.evaluate(() => window.klangwerk.record(500));
  expect(recording.frames).toBeGreaterThan(8_000);
  expect(recording.peak).toBeGreaterThan(10_000);
});
