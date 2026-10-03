import { Clock } from "./clock";
import { playThroughSilentSwitch } from "./ios";

/*
 * Time: an audio context that is made and woken inside the first tap, and a
 * transport that schedules steps a little ahead on the audio clock from a
 * worker's heartbeat. Offline contexts are driven by `renderUntil` instead.
 */

export interface HostOptions {
  /** Play into this context (an OfflineAudioContext for renders and tests) instead of making one. */
  context?: BaseAudioContext;
  latencyHint?: AudioContextLatencyCategory | number;
}

/** The audio context and what the app builds on it (its synth), made on the first `unlock`. */
export class AudioHost<T> {
  context: BaseAudioContext | null = null;
  graph: T | null = null;

  constructor(private readonly build: (context: BaseAudioContext) => T, private readonly options: HostOptions = {}) {}

  get ready(): boolean {
    return this.context !== null && (this.context instanceof OfflineAudioContext || this.context.state === "running");
  }

  get audioContext(): AudioContext | null {
    return this.context instanceof AudioContext ? this.context : null;
  }

  /** Makes the context on the first tap (browsers only allow sound after one) and wakes it up. */
  async unlock(): Promise<boolean> {
    // iPhones: play even with the ring/silent switch on silent (only for the live sound, not offline renders).
    if (!this.options.context) playThroughSilentSwitch();
    if (!this.context) {
      this.context = this.options.context ?? new AudioContext({ latencyHint: this.options.latencyHint ?? "balanced" });
      this.graph = this.build(this.context);
    }
    if (this.context instanceof AudioContext && this.context.state !== "running") {
      await this.context.resume().catch(() => undefined);
    }
    return this.ready;
  }

  /** Where the listener is: the audio clock minus what is still on its way to the speaker. */
  visualTime(): number {
    const context = this.context;
    if (!context) return 0;
    const latency = context instanceof AudioContext ? (context.outputLatency || context.baseLatency || 0) : 0;
    return context.currentTime - latency;
  }

  /** Closes a context it made itself. */
  close(): void {
    if (this.context instanceof AudioContext && !this.options.context) void this.context.close().catch(() => undefined);
    this.context = null;
    this.graph = null;
  }
}

export interface TransportOptions {
  /** Schedules everything of step `step` (counted from the start) at `time`; it may `halt` the transport. */
  step(step: number, time: number): void;
  /** Seconds the coming step lasts (it may change with the tempo). */
  stepDuration(): number;
  /** How far the odd steps lean back, as a share of a step (0 straight; Tone.js's swing on 16ths is `swing · 2/3`). */
  swing?(): number;
  /** How far ahead steps are scheduled, in seconds. */
  lookahead?: number;
  /** After a stall (a hidden tab, a busy phone) the transport skips ahead instead of rushing through missed steps, in whole groups of this many steps (16: bars, so bar-bound changes still land on a bar line). */
  skipGroup?: number;
  /** Called with the number of steps a stall skipped. */
  skipped?(steps: number): void;
}

const STALL_SECONDS = 0.2;

export class Transport {
  running = false;
  /** The next step to schedule, counted from the start. */
  step = 0;
  /** When it sounds, on the audio clock. */
  nextTime = 0;
  private context: BaseAudioContext | null = null;
  private clock: Clock | null = null;

  constructor(private readonly options: TransportOptions) {}

  /** Starts at step 0 at `at`; a live context gets the worker's heartbeat. */
  begin(context: BaseAudioContext, at: number): void {
    this.context = context;
    this.running = true;
    this.step = 0;
    this.nextTime = at;
    if (typeof AudioContext !== "undefined" && context instanceof AudioContext) {
      this.clock ??= new Clock(() => this.scheduleAhead());
      this.clock.start();
    }
  }

  /** Stops scheduling; what is already scheduled rings out. */
  halt(): void {
    this.running = false;
    this.clock?.stop();
  }

  scheduleAhead(): void {
    const context = this.context;
    if (!this.running || !context) return;
    const until = context.currentTime + (this.options.lookahead ?? 0.12);
    if (this.nextTime < context.currentTime - STALL_SECONDS) {
      const duration = this.options.stepDuration();
      const behind = Math.ceil((context.currentTime - this.nextTime) / duration);
      const group = this.options.skipGroup ?? 1;
      const skip = Math.ceil(behind / group) * group;
      this.step += skip;
      this.nextTime += skip * duration;
      this.options.skipped?.(skip);
    }
    while (this.running && this.nextTime < until) this.scheduleStep();
  }

  /** Schedules everything up to `seconds`: for an OfflineAudioContext, before and while it renders. */
  renderUntil(seconds: number): void {
    while (this.running && this.nextTime < seconds) this.scheduleStep();
  }

  dispose(): void {
    this.halt();
    this.clock?.dispose();
    this.clock = null;
  }

  private scheduleStep(): void {
    const duration = this.options.stepDuration();
    const lean = this.step % 2 === 1 ? (this.options.swing?.() ?? 0) * duration : 0;
    this.options.step(this.step, lean ? this.nextTime + lean : this.nextTime);
    if (!this.running) return;
    this.step += 1;
    this.nextTime += duration;
  }
}
