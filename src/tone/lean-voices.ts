import { dbToGain, type Param } from "../param";
import { connect, currentTime, Gain, param, SoundNode } from "./lite";

/*
 * Lean voices: the same oscillator, envelope and noise behaviour as the
 * Tone.js instruments the banks used before (Synth, MembraneSynth, NoiseSynth,
 * OmniOscillator with fat and FM types, AmplitudeEnvelope), built from native
 * nodes. Envelope and pitch automation run through Klangwerk's Param (Tone's
 * Param semantics), so the curves are Tone's own; only the Signal and
 * ConstantSource plumbing is gone.
 */

export type BasicWave = "sine" | "triangle" | "sawtooth" | "square";

export type ToneSpec =
  | { kind: "basic"; type: BasicWave }
  | { kind: "pulse"; width: number }
  | { kind: "fat"; type: BasicWave; count: number; spread: number }
  | { kind: "fm"; type: BasicWave; modulationType: BasicWave; harmonicity: number; modulationIndex: number };

type Curve = "linear" | "exponential";

interface MappedTarget {
  param: Param;
  scale: number;
  offset: number;
}

/** Drives several params from one value: `value · scale + offset` each (FM ratios, fat detune spread). */
export class MappedParam {
  private current: number;

  constructor(private readonly targets: readonly MappedTarget[], initial: number) {
    this.current = initial;
    // An event at time 0, not at "now": offline renders trigger up to one block
    // after the note time, and an event at "now" would land after the note's
    // own automation (cutting a kick's pitch sweep). Time 0 precedes every real
    // event and still gives Tone's timeline the value ramps start from.
    for (const target of targets) target.param.setValueAtTime((initial * target.scale + target.offset), 0);
  }

  get value(): number {
    return this.current;
  }

  set value(value: number) {
    this.current = value;
    for (const target of this.targets) target.param.value = (value * target.scale + target.offset);
  }

  setValueAtTime(value: number, time: number): this {
    for (const target of this.targets) target.param.setValueAtTime(this.map(target, value), time);
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    for (const target of this.targets) target.param.exponentialRampToValueAtTime(this.map(target, value), time);
    return this;
  }

  exponentialRampTo(value: number, rampTime: number, startTime?: number): this {
    for (const target of this.targets) target.param.exponentialRampTo(this.map(target, value), rampTime, startTime);
    return this;
  }

  linearRampTo(value: number, rampTime: number, startTime?: number): this {
    for (const target of this.targets) target.param.linearRampTo(this.map(target, value), rampTime, startTime);
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    for (const target of this.targets) target.param.cancelAndHoldAtTime(time);
    return this;
  }

  dispose(): void {
  }

  private map(target: MappedTarget, value: number): number {
    return value * target.scale + target.offset;
  }
}

const waveCache = new WeakMap<object, Map<string, PeriodicWave>>();

/** Tone.Oscillator's wave for a phase offset: 2048 partials, real[n] = −b·sin(φn), imag[n] = b·cos(φn). */
function phasedWave(context: BaseAudioContext, type: BasicWave, phaseDegrees: number): PeriodicWave {
  const key = `${type}:${phaseDegrees}`;
  const cache = waveCache.get(context) ?? new Map<string, PeriodicWave>();
  waveCache.set(context, cache);
  const cached = cache.get(key);
  if (cached) return cached;
  const size = 2048;
  const phase = (phaseDegrees * Math.PI) / 180;
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  for (let n = 1; n < size; n += 1) {
    const piFactor = 2 / (n * Math.PI);
    let b = 0;
    if (type === "sine") b = n <= 1 ? 1 : 0;
    else if (type === "square") b = n & 1 ? 2 * piFactor : 0;
    else if (type === "sawtooth") b = piFactor * (n & 1 ? 1 : -1);
    else b = n & 1 ? 2 * piFactor * piFactor * (((n - 1) >> 1) & 1 ? -1 : 1) : 0;
    real[n] = b === 0 ? 0 : -b * Math.sin(phase * n);
    imag[n] = b === 0 ? 0 : b * Math.cos(phase * n);
  }
  const wave = context.createPeriodicWave(real, imag);
  cache.set(key, wave);
  return wave;
}

let sharedPulseCurve: Float32Array<ArrayBuffer> | null = null;

/** Tone.WaveShaper's 1024-point map of `v <= 0 ? -1 : 1` over [−1, 1]. */
function pulseCurve(): Float32Array<ArrayBuffer> {
  if (sharedPulseCurve) return sharedPulseCurve;
  const length = 1024;
  const curve = new Float32Array(new ArrayBuffer(length * Float32Array.BYTES_PER_ELEMENT));
  for (let index = 0; index < length; index += 1) curve[index] = (index / (length - 1)) * 2 - 1 <= 0 ? -1 : 1;
  sharedPulseCurve = curve;
  return curve;
}

function oscillator(context: BaseAudioContext, type: BasicWave, phaseDegrees = 0): OscillatorNode {
  const node = context.createOscillator();
  if (phaseDegrees % 360 === 0) node.type = type;
  else node.setPeriodicWave(phasedWave(context, type, phaseDegrees));
  return node;
}

/**
 * The oscillator part of Tone.OmniOscillator for the types the banks use:
 * basic waves, fat oscillators (`count` voices, −6 − 1.1·count dB each,
 * detuned across `spread` cents, phases spread over the cycle) and FM
 * (carrier plus modulator at `harmonicity`, depth `modulationIndex · f`).
 */
export class LeanTone {
  /** The level gain of a fat oscillator; otherwise the source itself (a unity gain would cost a node per note). */
  readonly output: AudioNode;
  readonly frequency: MappedParam;
  readonly detune: MappedParam;
  private readonly sources: OscillatorNode[];
  private readonly extraNodes: AudioNode[];

  constructor(readonly context: BaseAudioContext, spec: ToneSpec, frequency = 440, detune = 0) {
    this.extraNodes = [];
    if (spec.kind === "fat") {
      const count = Math.max(1, Math.round(spec.count));
      const level = context.createGain();
      level.gain.value = dbToGain(-6 - count * 1.1);
      this.output = level;
      this.sources = Array.from({ length: count }, (_, index) => oscillator(context, spec.type, (index / count) * 360));
      this.sources.forEach((source) => source.connect(level));
      const start = -spec.spread / 2;
      const step = count > 1 ? spec.spread / (count - 1) : 0;
      this.frequency = new MappedParam(this.sources.map((source) => ({ param: param(source.frequency, "frequency"), scale: 1, offset: 0 })), frequency);
      this.detune = new MappedParam(this.sources.map((source, index) => ({ param: param(source.detune, "cents"), scale: 1, offset: count > 1 ? start + step * index : 0 })), detune);
    } else if (spec.kind === "pulse") {
      // Tone.PulseOscillator: a triangle plus the width offset through a sign curve.
      const triangle = oscillator(context, "triangle");
      const width = context.createConstantSource();
      width.offset.value = spec.width;
      const threshold = context.createWaveShaper();
      threshold.curve = pulseCurve();
      triangle.connect(threshold);
      width.connect(threshold);
      this.output = threshold;
      this.sources = [triangle, width as unknown as OscillatorNode];
      this.extraNodes.push(threshold);
      this.frequency = new MappedParam([{ param: param(triangle.frequency, "frequency"), scale: 1, offset: 0 }], frequency);
      this.detune = new MappedParam([{ param: param(triangle.detune, "cents"), scale: 1, offset: 0 }], detune);
    } else if (spec.kind === "fm") {
      const carrier = oscillator(context, spec.type);
      const modulator = oscillator(context, spec.modulationType);
      const depth = context.createGain();
      carrier.frequency.value = 0;
      depth.gain.value = 0;
      modulator.connect(depth);
      depth.connect(carrier.frequency);
      this.output = carrier;
      this.sources = [carrier, modulator];
      this.extraNodes.push(depth);
      this.frequency = new MappedParam([
        { param: param(carrier.frequency, "frequency"), scale: 1, offset: 0 },
        { param: param(modulator.frequency, "frequency"), scale: spec.harmonicity, offset: 0 },
        { param: param(depth.gain, "frequency"), scale: spec.modulationIndex, offset: 0 },
      ], frequency);
      this.detune = new MappedParam([
        { param: param(carrier.detune, "cents"), scale: 1, offset: 0 },
        { param: param(modulator.detune, "cents"), scale: 1, offset: 0 },
      ], detune);
    } else {
      const source = oscillator(context, spec.type);
      this.output = source;
      this.sources = [source];
      this.frequency = new MappedParam([{ param: param(source.frequency, "frequency"), scale: 1, offset: 0 }], frequency);
      this.detune = new MappedParam([{ param: param(source.detune, "cents"), scale: 1, offset: 0 }], detune);
    }
  }

  start(time: number): this {
    for (const source of this.sources) source.start(time);
    return this;
  }

  /** The oscillators' native detune params, for a persistent detune source to add to. */
  get detuneTargets(): AudioParam[] {
    return this.sources.filter((source): source is OscillatorNode => "detune" in source).map((source) => source.detune);
  }

  onEnded(callback: () => void): void {
    this.sources[0]!.addEventListener("ended", callback, { once: true });
  }

  stop(time: number): this {
    for (const source of this.sources) {
      try {
        source.stop(time);
      } catch {
        // a native source can only be stopped once
      }
    }
    return this;
  }

  /** Releases the nodes once the sources have ended. */
  disposeWhenEnded(): void {
    this.sources[0]!.addEventListener("ended", () => this.dispose(), { once: true });
  }

  dispose(): void {
    this.frequency.dispose();
    this.detune.dispose();
    for (const node of [...this.sources, ...this.extraNodes, this.output]) node.disconnect();
  }
}

/**
 * A persistent detune in cents, like Tone.Synth.detune, fed natively into
 * each note's oscillators. Tone.Signal.connect() would zero the target's own
 * value and wipe a fat oscillator's spread offsets (Tone avoids that there
 * with `overridden = false`), so this adds to the target instead.
 */
export class DetuneSource {
  readonly param: Param;
  private readonly source: ConstantSourceNode;

  constructor(context: BaseAudioContext) {
    this.source = context.createConstantSource();
    this.param = param(this.source.offset, "cents");
    this.param.setValueAtTime(0, 0);
    this.source.start(currentTime());
  }

  get value(): number {
    return Number(this.param.value);
  }

  set value(value: number) {
    this.param.value = value;
  }

  setValueAtTime(value: number, time: number): this {
    this.param.setValueAtTime(value, time);
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.param.linearRampToValueAtTime(value, time);
    return this;
  }

  rampTo(value: number, rampTime: number, startTime?: number): this {
    this.param.rampTo(value, rampTime, startTime);
    return this;
  }

  connectTo(target: AudioParam): void {
    this.source.connect(target);
  }

  disconnectFrom(target: AudioParam): void {
    try {
      this.source.disconnect(target);
    } catch {
      // already disconnected
    }
  }

  dispose(): void {
    try {
      this.source.stop();
    } catch {
      // already stopped
    }
    this.source.disconnect();
  }
}

export interface EnvelopeOptions {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  attackCurve?: Curve;
  decayCurve?: Curve;
  releaseCurve?: Curve;
}

/** Tone.AmplitudeEnvelope: a gain whose level follows Tone.Envelope's attack, decay and release automation. */
export class LeanEnvelope extends SoundNode {
  readonly name = "LeanEnvelope";
  readonly input: GainNode;
  readonly output: GainNode;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
  private readonly attackCurve: Curve;
  private readonly decayCurve: Curve;
  private readonly releaseCurve: Curve;
  private readonly level: Param;

  constructor(options: EnvelopeOptions) {
    super();
    this.input = this.output = this.context.createGain();
    this.level = param(this.input.gain, "number");
    this.level.value = 0;
    this.attack = options.attack;
    this.decay = options.decay;
    this.sustain = options.sustain;
    this.release = options.release;
    this.attackCurve = options.attackCurve ?? "linear";
    this.decayCurve = options.decayCurve ?? "exponential";
    this.releaseCurve = options.releaseCurve ?? "exponential";
  }

  getValueAtTime(time: number): number {
    return Number(this.level.getValueAtTime(time));
  }

  triggerAttack(time: number, velocity = 1): this {
    let attack = this.attack;
    const currentValue = this.getValueAtTime(time);
    if (currentValue > 0) attack = (1 - currentValue) / (1 / attack);
    if (attack < this.sampleTime) {
      this.level.cancelScheduledValues(time);
      this.level.setValueAtTime(velocity, time);
    } else if (this.attackCurve === "linear") {
      this.level.linearRampTo(velocity, attack, time);
    } else {
      this.level.targetRampTo(velocity, attack, time);
    }
    if (this.decay && this.sustain < 1) {
      const decayValue = velocity * this.sustain;
      const decayStart = time + attack;
      if (this.decayCurve === "linear") this.level.linearRampToValueAtTime(decayValue, this.decay + decayStart);
      else this.level.exponentialApproachValueAtTime(decayValue, decayStart, this.decay);
    }
    return this;
  }

  triggerRelease(time: number = this.now()): this {
    const currentValue = this.getValueAtTime(time);
    if (currentValue > 0) {
      if (this.release < this.sampleTime) this.level.setValueAtTime(0, time);
      else if (this.releaseCurve === "linear") this.level.linearRampTo(0, this.release, time);
      else this.level.targetRampTo(0, this.release, time);
    }
    return this;
  }

  triggerAttackRelease(duration: number, time: number, velocity = 1): this {
    this.triggerAttack(time, velocity);
    this.triggerRelease(time + duration);
    return this;
  }

  dispose(): this {
    super.dispose();
    this.input.disconnect();
    return this;
  }
}

export interface OneShotVoiceOptions {
  envelope: EnvelopeOptions;
  volume?: number;
  /** A persistent detune (cents) every note follows, like Tone.Synth.detune. */
  detune?: boolean;
  /** A note that overlaps the previous one starts a fresh oscillator (Groovebox's voices) instead of running on at the new pitch. */
  restart?: boolean;
}

/**
 * Tone.Synth / MembraneSynth behaviour for percussive notes: a note gets a
 * fresh oscillator, which stops once the envelope is silent. A note that
 * arrives while the previous one still sounds keeps that oscillator running
 * at the new pitch, as Tone's monophonic synths do, or with `restart` cuts it
 * at the new note and starts a fresh one.
 */
export class OneShotTone extends SoundNode {
  readonly name = "OneShotTone";
  readonly input = undefined;
  readonly output: SoundNode;
  readonly envelope: LeanEnvelope;
  /** Present when created with `detune: true`; it drives every note's oscillators. */
  readonly detune: DetuneSource | null;
  private current: { tone: LeanTone; stopAt: number } | null = null;
  private readonly restart: boolean;

  constructor(private readonly spec: ToneSpec, options: OneShotVoiceOptions & { pitch?: { octaves: number; pitchDecay: number } }) {
    super();
    this.envelope = new LeanEnvelope(options.envelope);
    this.output = options.volume === undefined ? this.envelope : this.envelope.connect(new Gain(options.volume, "decibels"));
    this.pitch = options.pitch ?? null;
    this.detune = options.detune ? new DetuneSource(this.context) : null;
    this.restart = options.restart === true;
  }

  private readonly pitch: { octaves: number; pitchDecay: number } | null;

  triggerAttackRelease(frequency: number, duration: number, time: number, velocity = 1): this {
    const release = time + duration;
    const stopAt = this.envelope.sustain === 0
      ? time + this.envelope.attack + this.envelope.decay
      : release + this.envelope.release;
    const sounding = this.current && this.current.stopAt > time ? this.current.tone : null;
    if (sounding && this.restart) sounding.stop(time);
    const running = this.restart ? null : sounding;
    const tone = running ?? new LeanTone(this.context, this.spec, frequency);
    if (!running) {
      if (this.detune) {
        const detune = this.detune;
        tone.detuneTargets.forEach((target) => detune.connectTo(target));
        tone.onEnded(() => tone.detuneTargets.forEach((target) => detune.disconnectFrom(target)));
      }
      tone.output.connect(this.envelope.input);
    }
    this.envelope.triggerAttack(time, velocity);
    if (this.pitch) {
      tone.frequency.setValueAtTime(frequency * 2 ** this.pitch.octaves, time);
      tone.frequency.exponentialRampToValueAtTime(frequency, time + this.pitch.pitchDecay);
    } else {
      tone.frequency.setValueAtTime(frequency, time);
    }
    if (running) {
      tone.stop(stopAt);
    } else {
      tone.start(time).stop(stopAt);
      tone.disposeWhenEnded();
    }
    this.envelope.triggerRelease(release);
    this.current = { tone, stopAt };
    return this;
  }

  triggerRelease(time: number = this.now()): this {
    this.envelope.triggerRelease(time);
    if (this.current && this.current.stopAt > time + this.envelope.release) {
      this.current.tone.stop(time + this.envelope.release);
      this.current.stopAt = time + this.envelope.release;
    }
    return this;
  }

  dispose(): this {
    super.dispose();
    this.current?.tone.stop(this.now());
    this.detune?.dispose();
    this.envelope.dispose();
    if (this.output !== this.envelope) this.output.dispose();
    return this;
  }
}

const noiseCache = new Map<"white" | "pink", AudioBuffer>();

/** Tone.Noise's 5-second stereo white and pink noise buffers. */
function noiseBuffer(context: BaseAudioContext, type: "white" | "pink"): AudioBuffer {
  const cached = noiseCache.get(type);
  if (cached && cached.sampleRate === context.sampleRate) return cached;
  const length = 44_100 * 5;
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channelNumber = 0; channelNumber < 2; channelNumber += 1) {
    const channel = buffer.getChannelData(channelNumber);
    if (type === "white") {
      for (let index = 0; index < length; index += 1) channel[index] = Math.random() * 2 - 1;
      continue;
    }
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      channel[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  }
  noiseCache.set(type, buffer);
  return buffer;
}

/**
 * Tone.NoiseSynth: looping noise from a random offset through an amplitude
 * envelope. With sustain 0 the noise stops after attack + decay, as in Tone.
 */
export class NoiseVoice extends SoundNode {
  readonly name = "NoiseVoice";
  readonly input = undefined;
  readonly output: LeanEnvelope;
  private current: { source: AudioBufferSourceNode; stopAt: number } | null = null;

  constructor(private readonly type: "white" | "pink", envelope: EnvelopeOptions) {
    super();
    this.output = new LeanEnvelope(envelope);
  }

  triggerAttackRelease(duration: number, time: number, velocity = 1): this {
    const envelope = this.output;
    const release = time + duration;
    const stopAt = envelope.sustain === 0 ? time + envelope.attack + envelope.decay : release + envelope.release;
    if (this.current && this.current.stopAt > time) this.current.source.stop(time);
    const buffer = noiseBuffer(this.context, this.type);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(envelope.input);
    envelope.triggerAttack(time, velocity);
    source.start(time, Math.random() * (buffer.duration - 0.001));
    source.stop(stopAt);
    source.addEventListener("ended", () => source.disconnect(), { once: true });
    envelope.triggerRelease(release);
    this.current = { source, stopAt };
    return this;
  }

  triggerRelease(time: number = this.now()): this {
    this.output.triggerRelease(time);
    return this;
  }

  dispose(): this {
    super.dispose();
    this.output.dispose();
    return this;
  }
}

export interface FmVoiceOptions {
  carrier: BasicWave;
  modulator: BasicWave;
  harmonicity: number;
  modulationIndex: number;
  envelope: EnvelopeOptions;
  modulationEnvelope: EnvelopeOptions;
}

/**
 * Tone.FMSynth: carrier and modulator are Synths at −10 dB with their own
 * envelopes (both follow the velocity); the modulator output times
 * f·modulationIndex is added to the carrier frequency, the modulator runs
 * at f·harmonicity, and one detune signal drives both.
 */
export class FmVoice extends SoundNode {
  readonly name = "FmVoice";
  readonly input = undefined;
  readonly output: Gain;
  readonly detune: DetuneSource;
  private readonly envelope: LeanEnvelope;
  private readonly modulationEnvelope: LeanEnvelope;
  private readonly modulationVolume: GainNode;
  private carrier: { node: OscillatorNode; depth: GainNode; stopAt: number } | null = null;
  private modulator: { node: OscillatorNode; stopAt: number } | null = null;

  constructor(private readonly options: FmVoiceOptions) {
    super();
    this.envelope = new LeanEnvelope(options.envelope);
    this.modulationEnvelope = new LeanEnvelope(options.modulationEnvelope);
    this.output = new Gain(-10, "decibels");
    this.envelope.connect(this.output);
    this.modulationVolume = this.context.createGain();
    this.modulationVolume.gain.value = dbToGain(-10);
    connect(this.modulationEnvelope, this.modulationVolume);
    this.detune = new DetuneSource(this.context);
  }

  triggerAttackRelease(frequency: number, duration: number, time: number, velocity = 1): this {
    const release = time + duration;
    const stopAt = this.envelope.sustain === 0 ? time + this.envelope.attack + this.envelope.decay : release + this.envelope.release;
    const modulatorStopAt = this.modulationEnvelope.sustain === 0
      ? time + this.modulationEnvelope.attack + this.modulationEnvelope.decay
      : release + this.modulationEnvelope.release;
    // Tone's carrier and modulator synths are monophonic: while an oscillator
    // still sounds, the next note keeps it running with the new pitch.
    const carrier = this.carrier && this.carrier.stopAt > time ? this.carrier : this.startCarrier(time);
    const modulator = this.modulator && this.modulator.stopAt > time ? this.modulator : this.startModulator(time);
    carrier.node.frequency.setValueAtTime(frequency, time);
    modulator.node.frequency.setValueAtTime(frequency * this.options.harmonicity, time);
    carrier.depth.gain.setValueAtTime(frequency * this.options.modulationIndex, time);
    this.envelope.triggerAttack(time, velocity);
    this.modulationEnvelope.triggerAttack(time, velocity);
    this.stopCarrier(carrier, stopAt);
    this.stopModulator(modulator, modulatorStopAt);
    this.envelope.triggerRelease(release);
    this.modulationEnvelope.triggerRelease(release);
    return this;
  }

  private startCarrier(time: number): { node: OscillatorNode; depth: GainNode; stopAt: number } {
    const node = this.context.createOscillator();
    node.type = this.options.carrier;
    node.frequency.value = 0;
    const depth = this.context.createGain();
    depth.gain.value = 0;
    this.detune.connectTo(node.detune);
    this.modulationVolume.connect(depth);
    depth.connect(node.frequency);
    node.connect(this.envelope.input);
    node.start(time);
    node.addEventListener("ended", () => {
      this.detune.disconnectFrom(node.detune);
      this.modulationVolume.disconnect(depth);
      depth.disconnect();
      node.disconnect();
    }, { once: true });
    this.carrier = { node, depth, stopAt: Infinity };
    return this.carrier;
  }

  private startModulator(time: number): { node: OscillatorNode; stopAt: number } {
    const node = this.context.createOscillator();
    node.type = this.options.modulator;
    this.detune.connectTo(node.detune);
    connect(node, this.modulationEnvelope);
    node.start(time);
    node.addEventListener("ended", () => {
      this.detune.disconnectFrom(node.detune);
      node.disconnect();
    }, { once: true });
    this.modulator = { node, stopAt: Infinity };
    return this.modulator;
  }

  private stopCarrier(carrier: { node: OscillatorNode; stopAt: number }, time: number): void {
    carrier.node.stop(time);
    carrier.stopAt = time;
  }

  private stopModulator(modulator: { node: OscillatorNode; stopAt: number }, time: number): void {
    modulator.node.stop(time);
    modulator.stopAt = time;
  }

  triggerRelease(time: number = this.now()): this {
    this.envelope.triggerRelease(time);
    this.modulationEnvelope.triggerRelease(time);
    if (this.carrier && this.carrier.stopAt > time + this.envelope.release) this.stopCarrier(this.carrier, time + this.envelope.release);
    if (this.modulator && this.modulator.stopAt > time + this.modulationEnvelope.release) {
      this.stopModulator(this.modulator, time + this.modulationEnvelope.release);
    }
    return this;
  }

  dispose(): this {
    super.dispose();
    this.detune.dispose();
    this.envelope.dispose();
    this.modulationEnvelope.dispose();
    this.modulationVolume.disconnect();
    this.output.dispose();
    return this;
  }
}
