import { describe, expect, it } from "vitest";
import { Transport } from "../src/transport";

/** An offline-like context whose clock the test moves by hand (not an AudioContext, so no worker clock). */
function fakeContext(): BaseAudioContext & { currentTime: number } {
  return { currentTime: 0 } as unknown as BaseAudioContext & { currentTime: number };
}

describe("transport", () => {
  it("schedules every step a lookahead ahead, on an exact grid", () => {
    const steps: [number, number][] = [];
    const transport = new Transport({ step: (step, time) => steps.push([step, time]), stepDuration: () => 0.125 });
    const context = fakeContext();
    transport.begin(context, 0.05);
    transport.scheduleAhead();
    expect(steps).toEqual([[0, 0.05]]);
    context.currentTime = 0.2;
    transport.scheduleAhead();
    expect(steps.map(([step]) => step)).toEqual([0, 1, 2]);
  });

  it("renders offline up to a time and stops when a step halts it", () => {
    const steps: number[] = [];
    const transport = new Transport({
      step: (step) => {
        steps.push(step);
        if (step === 5) transport.halt();
      },
      stepDuration: () => 0.1,
    });
    transport.begin(fakeContext(), 0);
    transport.renderUntil(0.35);
    expect(steps).toEqual([0, 1, 2, 3]);
    transport.renderUntil(10);
    expect(steps).toEqual([0, 1, 2, 3, 4, 5]);
    expect(transport.running).toBe(false);
    expect(transport.step).toBe(5);
  });

  it("swings the odd steps back by a share of a step, and keeps the grid", () => {
    const times: number[] = [];
    const transport = new Transport({ step: (_, time) => times.push(time), stepDuration: () => 0.1, swing: () => 0.25 });
    transport.begin(fakeContext(), 0);
    transport.renderUntil(0.4);
    expect(times.map((time) => Math.round(time * 1000))).toEqual([0, 125, 200, 325]);
  });

  it("skips a stall in whole groups and reports it, instead of rushing through missed steps", () => {
    const steps: number[] = [];
    const skips: number[] = [];
    const transport = new Transport({ step: (step) => steps.push(step), stepDuration: () => 0.1, skipGroup: 16, skipped: (count) => skips.push(count) });
    const context = fakeContext();
    transport.begin(context, 0);
    transport.scheduleAhead();
    context.currentTime = 1;
    transport.scheduleAhead();
    expect(skips).toEqual([16]);
    expect(transport.step).toBe(18);
    expect(transport.nextTime).toBeGreaterThan(context.currentTime);
    context.currentTime = 1.75;
    transport.scheduleAhead();
    expect(steps).toEqual([0, 1, 18]);
  });
});
