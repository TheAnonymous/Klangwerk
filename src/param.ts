/*
 * An AudioParam with memory: it keeps its own timeline of automation, so it
 * can say its value at any time, hold a ramp where it is and start a new one
 * from there (rampTo, cancelAndHoldAtTime), the way Tone.js's Param does.
 * The automation semantics are ported from Tone.js 15.5 (MIT License,
 * Copyright (c) 2014-2025 Yotam Mann), see THIRD_PARTY_NOTICES.md.
 */

const EPSILON = 1e-6;
const EQ = (a: number, b: number): boolean => Math.abs(a - b) < EPSILON;
const GT = (a: number, b: number): boolean => a > b + EPSILON;
const LT = (a: number, b: number): boolean => a + EPSILON < b;
const GTE = (a: number, b: number): boolean => GT(a, b) || EQ(a, b);

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (gain: number): number => 20 * (Math.log(gain) / Math.LN10);

type EventType = "setValueAtTime" | "linearRampToValueAtTime" | "exponentialRampToValueAtTime" | "setTargetAtTime";

interface AutomationEvent {
  type: EventType;
  time: number;
  value: number;
  constant?: number;
}

/** Events sorted by time; at equal times the later added one comes last. */
class Timeline {
  private events: AutomationEvent[] = [];

  constructor(private readonly memory: number) {}

  add(event: AutomationEvent): void {
    this.events.splice(this.search(event.time) + 1, 0, event);
    if (this.events.length > this.memory) this.events.splice(0, this.events.length - this.memory);
  }

  /** The last event at or before `time`. */
  get(time: number): AutomationEvent | null {
    const index = this.search(time);
    return index === -1 ? null : this.events[index]!;
  }

  getAfter(time: number): AutomationEvent | null {
    return this.events[this.search(time) + 1] ?? null;
  }

  getBefore(time: number): AutomationEvent | null {
    const length = this.events.length;
    if (length > 0 && this.events[length - 1]!.time < time) return this.events[length - 1]!;
    const index = this.search(time);
    return index - 1 >= 0 ? this.events[index - 1]! : null;
  }

  /** Removes the events at and after `after`. */
  cancel(after: number): void {
    if (this.events.length > 1) {
      let index = this.search(after);
      if (index >= 0) {
        if (EQ(this.events[index]!.time, after)) {
          for (let i = index; i >= 0; i -= 1) {
            if (EQ(this.events[i]!.time, after)) index = i;
            else break;
          }
          this.events = this.events.slice(0, index);
        } else {
          this.events = this.events.slice(0, index + 1);
        }
      } else {
        this.events = [];
      }
    } else if (this.events.length === 1 && GTE(this.events[0]!.time, after)) {
      this.events = [];
    }
  }

  private search(time: number): number {
    const events = this.events;
    if (events.length === 0) return -1;
    let beginning = 0;
    let end = events.length;
    if (events[events.length - 1]!.time <= time) return events.length - 1;
    while (beginning < end) {
      let middle = Math.floor(beginning + (end - beginning) / 2);
      const event = events[middle]!;
      const next = events[middle + 1];
      if (EQ(event.time, time)) {
        for (let i = middle; i < events.length; i += 1) {
          if (EQ(events[i]!.time, time)) middle = i;
          else break;
        }
        return middle;
      } else if (LT(event.time, time) && next && GT(next.time, time)) {
        return middle;
      } else if (GT(event.time, time)) {
        end = middle;
      } else {
        beginning = middle + 1;
      }
    }
    return -1;
  }
}

/** "decibels" (converted to gain, as long as `convert` is on) and "frequency" ramp exponentially in `rampTo`; the rest linearly. */
export type ParamUnits = "number" | "gain" | "decibels" | "frequency" | "cents" | "positive" | "normalRange" | "audioRange" | "time" | "hertz";

export interface ParamOptions {
  units?: ParamUnits;
  /** Convert decibels to gain (off for params that take decibels themselves, like a biquad's gain). */
  convert?: boolean;
  /** The starting value, set at time 0 (when it differs from the param's default). */
  value?: number;
  /** What "now" is for `value =` and ramps without a start time: the audio clock by default. */
  now?: () => number;
}

export class Param {
  readonly units: ParamUnits;
  readonly convert: boolean;
  private readonly events = new Timeline(1000);
  private readonly initialValue: number;
  private readonly minOutput = 1e-7;
  private readonly sampleTime: number;
  private readonly clock: () => number;

  constructor(readonly context: BaseAudioContext, readonly param: AudioParam, options: ParamOptions = {}) {
    this.units = options.units ?? "number";
    this.convert = options.convert ?? true;
    this.initialValue = param.defaultValue;
    this.sampleTime = 1 / context.sampleRate;
    this.clock = options.now ?? (() => context.currentTime);
    if (options.value !== undefined && options.value !== this.toType(this.initialValue)) this.setValueAtTime(options.value, 0);
  }

  now(): number {
    return this.clock();
  }

  get value(): number {
    return this.getValueAtTime(this.now());
  }

  set value(value: number) {
    const now = this.now();
    this.cancelScheduledValues(now);
    this.setValueAtTime(value, now);
  }

  setValueAtTime(value: number, time: number): this {
    const numeric = this.fromType(value);
    this.events.add({ time, type: "setValueAtTime", value: numeric });
    this.param.setValueAtTime(numeric, time);
    return this;
  }

  getValueAtTime(time: number): number {
    const at = Math.max(time, 0);
    const after = this.events.getAfter(at);
    const before = this.events.get(at);
    let value = this.initialValue;
    if (before === null) {
      value = this.initialValue;
    } else if (before.type === "setTargetAtTime" && (after === null || after.type === "setValueAtTime")) {
      const previous = this.events.getBefore(before.time);
      const previousValue = previous === null ? this.initialValue : previous.value;
      value = before.value + (previousValue - before.value) * Math.exp(-(at - before.time) / before.constant!);
    } else if (after === null) {
      value = before.value;
    } else if (after.type === "linearRampToValueAtTime" || after.type === "exponentialRampToValueAtTime") {
      let beforeValue = before.value;
      if (before.type === "setTargetAtTime") {
        const previous = this.events.getBefore(before.time);
        beforeValue = previous === null ? this.initialValue : previous.value;
      }
      const progress = (at - before.time) / (after.time - before.time);
      value = after.type === "linearRampToValueAtTime"
        ? beforeValue + (after.value - beforeValue) * progress
        : beforeValue * Math.pow(after.value / beforeValue, progress);
    } else {
      value = before.value;
    }
    return this.toType(value);
  }

  /** Holds the value the param has at `time` there, so a ramp can start from it. */
  setRampPoint(time: number): this {
    let current = this.getValueAtTime(time);
    this.cancelAndHoldAtTime(time);
    if (this.fromType(current) === 0) current = this.toType(this.minOutput);
    this.setValueAtTime(current, time);
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    const numeric = this.fromType(value);
    this.events.add({ time: endTime, type: "linearRampToValueAtTime", value: numeric });
    this.param.linearRampToValueAtTime(numeric, endTime);
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    let numeric = this.fromType(value);
    // An exponential ramp cannot reach 0.
    numeric = EQ(numeric, 0) ? this.minOutput : numeric;
    this.events.add({ time: endTime, type: "exponentialRampToValueAtTime", value: numeric });
    this.param.exponentialRampToValueAtTime(numeric, endTime);
    return this;
  }

  exponentialRampTo(value: number, rampTime: number, startTime = this.now()): this {
    this.setRampPoint(startTime);
    this.exponentialRampToValueAtTime(value, startTime + rampTime);
    return this;
  }

  linearRampTo(value: number, rampTime: number, startTime = this.now()): this {
    this.setRampPoint(startTime);
    this.linearRampToValueAtTime(value, startTime + rampTime);
    return this;
  }

  /** Approaches `value` within `rampTime` (an exponential approach that lands linearly). */
  targetRampTo(value: number, rampTime: number, startTime = this.now()): this {
    this.setRampPoint(startTime);
    this.exponentialApproachValueAtTime(value, startTime, rampTime);
    return this;
  }

  exponentialApproachValueAtTime(value: number, time: number, rampTime: number): this {
    const timeConstant = Math.log(rampTime + 1) / Math.log(200);
    this.setTargetAtTime(value, time, timeConstant);
    // At 90 % a linear ramp takes it to the final value.
    this.cancelAndHoldAtTime(time + rampTime * 0.9);
    this.linearRampToValueAtTime(value, time + rampTime);
    return this;
  }

  setTargetAtTime(value: number, startTime: number, timeConstant: number): this {
    const numeric = this.fromType(value);
    this.events.add({ constant: timeConstant, time: startTime, type: "setTargetAtTime", value: numeric });
    this.param.setTargetAtTime(numeric, startTime, timeConstant);
    return this;
  }

  setValueCurveAtTime(values: readonly number[], startTime: number, duration: number, scaling = 1): this {
    this.setValueAtTime(this.toType(this.fromType(values[0]!) * scaling), startTime);
    const segment = duration / (values.length - 1);
    for (let index = 1; index < values.length; index += 1) {
      this.linearRampToValueAtTime(this.toType(this.fromType(values[index]!) * scaling), startTime + index * segment);
    }
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.cancel(time);
    this.param.cancelScheduledValues(time);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    const valueAtTime = this.fromType(this.getValueAtTime(time));
    const before = this.events.get(time);
    const after = this.events.getAfter(time);
    if (before && EQ(before.time, time)) {
      if (after) {
        this.param.cancelScheduledValues(after.time);
        this.events.cancel(after.time);
      } else {
        this.param.cancelAndHoldAtTime(time);
        this.events.cancel(time + this.sampleTime);
      }
    } else if (after) {
      this.param.cancelScheduledValues(after.time);
      this.events.cancel(after.time);
      if (after.type === "linearRampToValueAtTime") this.linearRampToValueAtTime(this.toType(valueAtTime), time);
      else if (after.type === "exponentialRampToValueAtTime") this.exponentialRampToValueAtTime(this.toType(valueAtTime), time);
    }
    this.events.add({ time, type: "setValueAtTime", value: valueAtTime });
    this.param.setValueAtTime(valueAtTime, time);
    return this;
  }

  /** Exponentially for frequencies and decibels, linearly for everything else. */
  rampTo(value: number, rampTime = 0.1, startTime?: number): this {
    if (this.units === "frequency" || this.units === "decibels") this.exponentialRampTo(value, rampTime, startTime);
    else this.linearRampTo(value, rampTime, startTime);
    return this;
  }

  private fromType(value: number): number {
    if (!this.convert) return value;
    if (this.units === "decibels") return dbToGain(value);
    // Tone converts a frequency through its period: 1 / (1 / f), which can move the last bit.
    if (this.units === "frequency") return 1 / (1 / value);
    return value;
  }

  private toType(value: number): number {
    return this.convert && this.units === "decibels" ? gainToDb(value) : value;
  }
}
