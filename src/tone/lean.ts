import type { Param } from "../param";
import { connect, param, SoundNode } from "./lite";

/*
 * Lean replacements for Tone.js effect components.
 *
 * Tone's wrappers drive every parameter through a running ConstantSourceNode
 * and wrap effects in cross-fades, splitters and helper gains. Kitty's graph
 * ended up with about 1,650 native nodes, and Chromium spends roughly 1 ms of
 * audio-thread time per node and second, so live playback underran.
 * The classes below rebuild the same signal topology and the same parameter
 * mapping from plain native nodes; automation goes through Klangwerk's Param
 * (Tone.Param's semantics), which wraps an AudioParam without creating nodes.
 */

type Seconds = number;

/** Applies every automation call to several params that must move together (cascaded biquads, stereo LFOs). */
export class ParamGroup {
  constructor(private readonly params: readonly Param[]) {}

  get value(): number {
    return Number(this.params[0]!.value);
  }

  set value(value: number) {
    for (const param of this.params) param.value = value;
  }

  setValueAtTime(value: number, time: number): this {
    for (const param of this.params) param.setValueAtTime(value, time);
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    for (const param of this.params) param.linearRampToValueAtTime(value, time);
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    for (const param of this.params) param.exponentialRampToValueAtTime(value, time);
    return this;
  }

  setTargetAtTime(value: number, startTime: number, timeConstant: number): this {
    for (const param of this.params) param.setTargetAtTime(value, startTime, timeConstant);
    return this;
  }

  rampTo(value: number, rampTime: number, startTime?: number): this {
    for (const param of this.params) param.rampTo(value, rampTime, startTime);
    return this;
  }

  linearRampTo(value: number, rampTime: number, startTime?: number): this {
    for (const param of this.params) param.linearRampTo(value, rampTime, startTime);
    return this;
  }

  exponentialRampTo(value: number, rampTime: number, startTime?: number): this {
    for (const param of this.params) param.exponentialRampTo(value, rampTime, startTime);
    return this;
  }

  cancelScheduledValues(time: number): this {
    for (const param of this.params) param.cancelScheduledValues(time);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    for (const param of this.params) param.cancelAndHoldAtTime(time);
    return this;
  }

  dispose(): this {
    return this;
  }
}

export interface LeanFilterOptions {
  type: BiquadFilterType;
  /** Only filters whose rolloff changes at runtime need fixed input/output gains around the cascade. */
  mutableRolloff?: boolean;
  frequency: number;
  Q?: number;
  gain?: number;
  rolloff?: -12 | -24 | -48 | -96;
}

/**
 * Same as Tone.Filter: `rolloff / -12` cascaded biquads sharing frequency, Q
 * and gain. Changing `rolloff` rebuilds the cascade between fixed input and
 * output gains, as Tone does, but only when the value really changes.
 */
export class LeanFilter extends SoundNode {
  readonly name = "LeanFilter";
  readonly input: AudioNode;
  readonly output: AudioNode;
  private biquads: BiquadFilterNode[] = [];
  private groups: { frequency: ParamGroup; Q: ParamGroup; gain: ParamGroup; detune: ParamGroup } | null = null;
  private readonly frequencyModulators: Array<SoundNode | AudioNode> = [];
  private currentRolloff: -12 | -24 | -48 | -96;

  constructor(private readonly options: LeanFilterOptions) {
    super();
    this.currentRolloff = options.rolloff ?? -12;
    if (options.mutableRolloff) {
      this.input = this.context.createGain();
      this.output = this.context.createGain();
      this.build(options.frequency, options.Q ?? 1, options.gain ?? 0, 0);
    } else {
      this.build(options.frequency, options.Q ?? 1, options.gain ?? 0, 0);
      this.input = this.biquads[0]!;
      this.output = this.biquads[this.biquads.length - 1]!;
    }
  }

  get frequency(): ParamGroup {
    return this.groups!.frequency;
  }

  get Q(): ParamGroup {
    return this.groups!.Q;
  }

  get gain(): ParamGroup {
    return this.groups!.gain;
  }

  /** Shifts the cutoff in cents on top of the frequency and any modulator (a live cutoff knob). */
  get detune(): ParamGroup {
    return this.groups!.detune;
  }

  /**
   * Lets a signal (e.g. Tone.FrequencyEnvelope) set the cutoff, as connecting
   * it to Tone.Filter.frequency does: the intrinsic value becomes 0 and the
   * signal drives every biquad's frequency.
   */
  modulateFrequency(source: SoundNode | AudioNode): this {
    this.frequencyModulators.push(source);
    this.attachModulator(source);
    return this;
  }

  get rolloff(): -12 | -24 | -48 | -96 {
    return this.currentRolloff;
  }

  set rolloff(rolloff: -12 | -24 | -48 | -96) {
    if (rolloff === this.currentRolloff) return;
    if (!this.options.mutableRolloff) throw new Error("LeanFilter: rolloff is fixed; create it with mutableRolloff");
    this.currentRolloff = rolloff;
    const { frequency, Q, gain, detune } = this.groups!;
    this.build(frequency.value, Q.value, gain.value, detune.value);
  }

  dispose(): this {
    super.dispose();
    const biquads = this.biquads;
    this.teardown();
    biquads.forEach((biquad) => biquad.disconnect());
    if (this.options.mutableRolloff) this.input.disconnect();
    this.output.disconnect();
    return this;
  }

  private attachModulator(source: SoundNode | AudioNode): void {
    for (const biquad of this.biquads) {
      biquad.frequency.cancelScheduledValues(0);
      biquad.frequency.value = 0;
      connect(source, biquad.frequency);
    }
  }

  private build(frequency: number, q: number, gain: number, detune: number): void {
    this.teardown();
    const count = [-12, -24, -48, -96].indexOf(this.currentRolloff) + 1;
    this.biquads = Array.from({ length: count }, () => {
      const biquad = this.context.createBiquadFilter();
      biquad.type = this.options.type;
      return biquad;
    });
    const mutable = this.options.mutableRolloff === true;
    if (mutable) this.input.connect(this.biquads[0]!);
    this.biquads.forEach((biquad, index) => {
      const next = this.biquads[index + 1] ?? (mutable ? this.output : undefined);
      if (next) biquad.connect(next);
    });
    this.groups = {
      frequency: new ParamGroup(this.biquads.map((biquad) => param(biquad.frequency, "frequency", frequency))),
      Q: new ParamGroup(this.biquads.map((biquad) => param(biquad.Q, "positive", q))),
      // BiquadFilterNode.gain is already in decibels, so no conversion (as Tone.Filter's gain signal).
      gain: new ParamGroup(this.biquads.map((biquad) => param(biquad.gain, "decibels", gain, false))),
      detune: new ParamGroup(this.biquads.map((biquad) => param(biquad.detune, "cents", detune, false))),
    };
    this.frequencyModulators.forEach((source) => this.attachModulator(source));
  }

  private teardown(): void {
    if (this.groups) {
      this.groups.frequency.dispose();
      this.groups.Q.dispose();
      this.groups.gain.dispose();
      this.groups.detune.dispose();
    }
    if (this.options.mutableRolloff && this.biquads.length) {
      this.input.disconnect();
      this.biquads.forEach((biquad) => biquad.disconnect());
    }
    this.biquads = [];
  }
}

export interface LeanEq3Options {
  low?: number;
  mid?: number;
  high?: number;
  lowFrequency?: number;
  highFrequency?: number;
}

/**
 * Same as Tone.EQ3: Tone.MultibandSplit (12 dB/oct crossovers, Q 1) with a
 * decibel gain per band, summed into one output.
 */
export class LeanEq3 extends SoundNode {
  readonly name = "LeanEq3";
  readonly input: GainNode;
  readonly output: GainNode;
  readonly low: Param;
  readonly mid: Param;
  readonly high: Param;
  readonly lowFrequency: ParamGroup;
  readonly highFrequency: ParamGroup;
  private readonly nodes: AudioNode[];

  constructor(options: LeanEq3Options = {}) {
    super();
    const lowFrequency = options.lowFrequency ?? 400;
    const highFrequency = options.highFrequency ?? 2_500;
    const biquad = (type: BiquadFilterType, frequency: number) => {
      const node = this.context.createBiquadFilter();
      node.type = type;
      node.frequency.value = frequency;
      node.Q.value = 1;
      return node;
    };
    this.input = this.context.createGain();
    this.output = this.context.createGain();
    const lowBand = biquad("lowpass", lowFrequency);
    const lowMid = biquad("highpass", lowFrequency);
    const midBand = biquad("lowpass", highFrequency);
    const highBand = biquad("highpass", highFrequency);
    const lowGain = this.context.createGain();
    const midGain = this.context.createGain();
    const highGain = this.context.createGain();
    this.input.connect(lowBand);
    this.input.connect(highBand);
    this.input.connect(lowMid);
    lowMid.connect(midBand);
    lowBand.connect(lowGain);
    midBand.connect(midGain);
    highBand.connect(highGain);
    lowGain.connect(this.output);
    midGain.connect(this.output);
    highGain.connect(this.output);
    this.low = param(lowGain.gain, "decibels", options.low ?? 0);
    this.mid = param(midGain.gain, "decibels", options.mid ?? 0);
    this.high = param(highGain.gain, "decibels", options.high ?? 0);
    this.lowFrequency = new ParamGroup([lowBand, lowMid].map((node) => param(node.frequency, "frequency", lowFrequency)));
    this.highFrequency = new ParamGroup([midBand, highBand].map((node) => param(node.frequency, "frequency", highFrequency)));
    this.nodes = [this.input, lowBand, lowMid, midBand, highBand, lowGain, midGain, highGain, this.output];
  }

  dispose(): this {
    super.dispose();
    this.lowFrequency.dispose();
    this.highFrequency.dispose();
    this.nodes.forEach((node) => node.disconnect());
    return this;
  }
}

export interface LeanChorusOptions {
  frequency: number;
  /** Centre delay in milliseconds, as in Tone.Chorus. */
  delayTime: number;
  depth: number;
  spread?: number;
  feedback?: number;
  wet?: number;
}

/**
 * Same as Tone.Chorus: the stereo input is split, each side runs through a
 * delay whose time a sine LFO sweeps between `delay·(1 − depth)` and
 * `delay·(1 + depth)`, the two LFO phases `spread` degrees apart; the merged
 * signal feeds back by `feedback` and is blended with the dry input by
 * Tone's equal-power cross-fade.
 */
export class LeanChorus extends SoundNode {
  readonly name = "LeanChorus";
  readonly input: GainNode;
  readonly output: SoundNode | AudioNode;
  readonly frequency: ParamGroup;
  readonly wet: Param | null;
  private readonly nodes: AudioNode[];
  private readonly oscillators: OscillatorNode[];
  private readonly crossFade: LeanCrossFade | null;

  constructor(options: LeanChorusOptions) {
    super();
    const spread = options.spread ?? 180;
    const centre = options.delayTime / 1_000;
    const deviation = centre * options.depth;
    const min = Math.max(centre - deviation, 0);
    const max = centre + deviation;
    this.input = this.context.createGain();
    this.input.channelCount = 2;
    this.input.channelCountMode = "explicit";
    const split = this.context.createChannelSplitter(2);
    const merge = this.context.createChannelMerger(2);
    this.input.connect(split);
    const phases = [90 - spread / 2, 90 + spread / 2];
    this.oscillators = [];
    const sides = phases.map((phaseDegrees, channel) => {
      const delay = this.context.createDelay(1);
      delay.delayTime.value = (min + max) / 2;
      const depth = this.context.createGain();
      depth.gain.value = (max - min) / 2;
      const oscillator = this.context.createOscillator();
      if (phaseDegrees % 360 === 0) oscillator.type = "sine";
      else oscillator.setPeriodicWave(sineWithPhase(this.context, phaseDegrees));
      oscillator.frequency.value = options.frequency;
      oscillator.connect(depth);
      depth.connect(delay.delayTime);
      split.connect(delay, channel, 0);
      delay.connect(merge, 0, channel);
      this.oscillators.push(oscillator);
      return [delay, depth, oscillator] as AudioNode[];
    });
    this.nodes = [this.input, split, merge, ...sides.flat()];
    if (options.feedback) {
      const feedback = this.context.createGain();
      feedback.gain.value = options.feedback;
      merge.connect(feedback);
      feedback.connect(split);
      this.nodes.push(feedback);
    }
    const startAt = this.context.currentTime;
    this.oscillators.forEach((oscillator) => oscillator.start(startAt));
    this.frequency = new ParamGroup(this.oscillators.map((oscillator) => param(oscillator.frequency, "frequency")));
    if (options.wet === undefined || options.wet === 1) {
      this.crossFade = null;
      this.wet = null;
      this.output = merge;
    } else {
      this.crossFade = new LeanCrossFade(options.wet);
      this.input.connect(this.crossFade.a);
      merge.connect(this.crossFade.b);
      this.wet = this.crossFade.fade;
      this.output = this.crossFade;
    }
  }

  dispose(): this {
    super.dispose();
    this.frequency.dispose();
    this.crossFade?.dispose();
    this.oscillators.forEach((oscillator) => {
      try {
        oscillator.stop();
      } catch {
        // already stopped
      }
    });
    this.nodes.forEach((node) => node.disconnect());
    return this;
  }
}

/**
 * Tone.CrossFade: a constant 1 through a mono StereoPanner at `2·fade − 1`
 * gives the equal-power gains cos(fade·π/2) and sin(fade·π/2) for a and b.
 */
export class LeanCrossFade extends SoundNode {
  readonly name = "LeanCrossFade";
  readonly input = undefined;
  readonly output: GainNode;
  readonly a: GainNode;
  readonly b: GainNode;
  readonly fade: Param;
  private readonly nodes: AudioNode[];
  private readonly constant: ConstantSourceNode;

  constructor(fade: number) {
    super();
    this.a = this.context.createGain();
    this.b = this.context.createGain();
    this.a.gain.value = 0;
    this.b.gain.value = 0;
    this.output = this.context.createGain();
    this.a.connect(this.output);
    this.b.connect(this.output);
    this.constant = this.context.createConstantSource();
    const panner = this.context.createStereoPanner();
    panner.channelCount = 1;
    panner.channelCountMode = "explicit";
    const split = this.context.createChannelSplitter(2);
    this.constant.connect(panner);
    panner.connect(split);
    split.connect(this.a.gain, 0);
    split.connect(this.b.gain, 1);
    panner.pan.value = 0;
    this.fade = new AffineParam(this.context, panner.pan, 2, -1, fade) as unknown as Param;
    this.constant.start(this.context.currentTime);
    this.nodes = [this.a, this.b, this.output, panner, split, this.constant];
  }

  dispose(): this {
    super.dispose();
    try {
      this.constant.stop();
    } catch {
      // already stopped
    }
    this.nodes.forEach((node) => node.disconnect());
    return this;
  }
}

/**
 * A normal-range value mapped onto a native param as `value · scale + offset`
 * (cross-fade pan, stereo-widener cross gains). The mapping is affine, so
 * linear ramps stay exact.
 */
export class AffineParam {
  private readonly target: Param;
  private current: number;

  constructor(_context: BaseAudioContext, native: AudioParam, private readonly scale: number, private readonly offset: number, initial: number) {
    this.target = param(native, "number");
    this.current = initial;
    // An event at time 0 precedes any real automation (also in offline renders,
    // where callbacks run after their note time) and gives Tone's own timeline
    // the start value that ramps (setRampPoint) begin from.
    this.target.setValueAtTime(this.map(initial), 0);
  }

  get value(): number {
    return this.current;
  }

  set value(value: number) {
    this.current = value;
    this.target.value = this.map(value);
  }

  setValueAtTime(value: number, time: number): this {
    this.target.setValueAtTime(this.map(value), time);
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.target.linearRampToValueAtTime(this.map(value), time);
    return this;
  }

  rampTo(value: number, rampTime: number, startTime?: number): this {
    this.target.linearRampTo(this.map(value), rampTime, startTime);
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.target.cancelScheduledValues(time);
    return this;
  }

  dispose(): this {
    return this;
  }

  private map(value: number): number {
    return value * this.scale + this.offset;
  }
}

/**
 * Same as Tone.StereoWidener (wet 1): in mid/side terms mid·2(1 − w) and
 * side·2w, which in left/right terms is L′ = L + (1 − 2w)·R and
 * R′ = R + (1 − 2w)·L. Mono input is centred first, as Tone's splitter does.
 */
export class LeanStereoWidener extends SoundNode {
  readonly name = "LeanStereoWidener";
  readonly input: ChannelSplitterNode;
  readonly output: ChannelMergerNode;
  readonly width: AffineParam;
  private readonly crossGains: ParamGroupAffine;
  private readonly nodes: AudioNode[];

  constructor(width: number) {
    super();
    this.input = this.context.createChannelSplitter(2);
    this.output = this.context.createChannelMerger(2);
    const toLeft = this.context.createGain();
    const toRight = this.context.createGain();
    this.input.connect(this.output, 0, 0);
    this.input.connect(this.output, 1, 1);
    this.input.connect(toLeft, 1);
    this.input.connect(toRight, 0);
    toLeft.connect(this.output, 0, 0);
    toRight.connect(this.output, 0, 1);
    this.crossGains = new ParamGroupAffine([
      new AffineParam(this.context, toLeft.gain, -2, 1, width),
      new AffineParam(this.context, toRight.gain, -2, 1, width),
    ]);
    this.width = this.crossGains as unknown as AffineParam;
    this.nodes = [this.input, this.output, toLeft, toRight];
  }

  dispose(): this {
    super.dispose();
    this.crossGains.dispose();
    this.nodes.forEach((node) => node.disconnect());
    return this;
  }
}

class ParamGroupAffine {
  constructor(private readonly params: readonly AffineParam[]) {}
  get value(): number {
    return this.params[0]!.value;
  }
  set value(value: number) {
    for (const entry of this.params) entry.value = value;
  }
  setValueAtTime(value: number, time: number): this {
    for (const entry of this.params) entry.setValueAtTime(value, time);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    for (const entry of this.params) entry.linearRampToValueAtTime(value, time);
    return this;
  }
  rampTo(value: number, rampTime: number, startTime?: number): this {
    for (const entry of this.params) entry.rampTo(value, rampTime, startTime);
    return this;
  }
  cancelScheduledValues(time: number): this {
    for (const entry of this.params) entry.cancelScheduledValues(time);
    return this;
  }
  dispose(): void {
    for (const entry of this.params) entry.dispose();
  }
}

export interface LeanVibratoOptions {
  frequency: number;
  depth: number;
  maxDelay: number;
  wet: number;
}

/**
 * Same as Tone.Vibrato: a delay swept by a sine LFO (phase −90°) between 0
 * and `maxDelay`, scaled by `depth`, blended by Tone's equal-power cross-fade.
 */
export class LeanVibrato extends SoundNode {
  readonly name = "LeanVibrato";
  readonly input: GainNode;
  readonly output: LeanCrossFade;
  readonly depth: AffineParam;
  readonly wet: Param;
  private readonly oscillator: OscillatorNode;
  private readonly nodes: AudioNode[];

  constructor(options: LeanVibratoOptions) {
    super();
    this.input = this.context.createGain();
    const delay = this.context.createDelay(options.maxDelay);
    delay.delayTime.value = options.maxDelay / 2;
    const modulation = this.context.createGain();
    this.oscillator = this.context.createOscillator();
    this.oscillator.setPeriodicWave(sineWithPhase(this.context, -90));
    this.oscillator.frequency.value = options.frequency;
    this.oscillator.connect(modulation);
    modulation.connect(delay.delayTime);
    this.depth = new AffineParam(this.context, modulation.gain, options.maxDelay / 2, 0, options.depth);
    this.output = new LeanCrossFade(options.wet);
    this.wet = this.output.fade;
    this.input.connect(this.output.a);
    this.input.connect(delay);
    delay.connect(this.output.b);
    this.oscillator.start(this.context.currentTime);
    this.nodes = [this.input, delay, modulation, this.oscillator];
  }

  dispose(): this {
    super.dispose();
    this.depth.dispose();
    this.output.dispose();
    try {
      this.oscillator.stop();
    } catch {
      // already stopped
    }
    this.nodes.forEach((node) => node.disconnect());
    return this;
  }
}

/** Tone.Oscillator's phase-shifted sine: real[1] = −sin φ, imag[1] = cos φ. */
function sineWithPhase(context: BaseAudioContext, degrees: number): PeriodicWave {
  const phase = (degrees * Math.PI) / 180;
  const real = new Float32Array([0, -Math.sin(phase)]);
  const imag = new Float32Array([0, Math.cos(phase)]);
  return context.createPeriodicWave(real, imag);
}

/**
 * Keeps a sound source connected to its destination only while it can be
 * audible. Chromium only processes nodes reachable from the destination, so a
 * sleeping bank costs nothing. Offline renders stay connected throughout.
 */
export class SleepyOutput {
  private connected = false;
  private silentAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly source: SoundNode,
    private readonly destination: SoundNode | AudioNode,
    private readonly alwaysAwake: boolean,
  ) {
    if (alwaysAwake) this.wake(0, Number.POSITIVE_INFINITY);
  }

  /** Connects now (the note is scheduled ahead) and stays awake until `until` (context time). */
  wake(_time: Seconds, until: Seconds): void {
    this.silentAt = Math.max(this.silentAt, until);
    if (!this.connected) {
      this.source.connect(this.destination);
      this.connected = true;
    }
    if (this.alwaysAwake || !Number.isFinite(this.silentAt)) return;
    this.schedule();
  }

  sleepNow(): void {
    if (this.alwaysAwake) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.silentAt = 0;
    if (this.connected) {
      this.source.disconnect(this.destination);
      this.connected = false;
    }
  }

  get awake(): boolean {
    return this.connected;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    const delay = Math.max(0, (this.silentAt - this.source.context.currentTime) * 1_000) + 50;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.source.context.currentTime < this.silentAt) {
        this.schedule();
        return;
      }
      if (this.connected) {
        this.source.disconnect(this.destination);
        this.connected = false;
      }
    }, delay);
  }
}
