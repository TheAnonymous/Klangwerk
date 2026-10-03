import { expect, test } from "@playwright/test";

interface Harness {
  renderTwice(seconds: number): Promise<{ peak: number; rmsDb: number; nonFinite: number; digest: string; steps: number; difference: number }>;
  clockTicks(ms: number): Promise<number>;
  record(ms: number): Promise<{ frames: number; peak: number }>;
  paramConformance(seeds: number): Promise<{ worstValue: number; worstSample: number }>;
  paramWithoutCancelAndHold(seeds: number): Promise<{ worstSample: number }>;
  frequencyEnvelopeConformance(): Promise<{ worst: number; peak: number }>;
  noteValueConformance(): string[];
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

test("Param automates exactly like Tone.Param: 1000 random sequences of ramps, holds and approaches", async ({ page }) => {
  const result = await page.evaluate(() => window.klangwerk.paramConformance(1000));
  expect(result).toEqual({ worstValue: 0, worstSample: 0 });
});

test("Param holds the same without the browser's cancelAndHoldAtTime (Firefox)", async ({ page }) => {
  const result = await page.evaluate(() => window.klangwerk.paramWithoutCancelAndHold(300));
  expect(result).toEqual({ worstSample: 0 });
});

test("the Tone layer's FrequencyEnvelope renders like Tone.FrequencyEnvelope", async ({ page }) => {
  const result = await page.evaluate(() => window.klangwerk.frequencyEnvelopeConformance());
  expect(result.peak).toBeGreaterThan(400);
  expect(result.worst).toBeLessThan(1e-6);
});

test("note values (incl. triplets) and pitches match Tone.Time and Tone.Frequency bit for bit", async ({ page }) => {
  expect(await page.evaluate(() => window.klangwerk.noteValueConformance())).toEqual([]);
});
