import { Param, type ParamUnits } from "../param";

/*
 * The pieces of Tone.js that the Musik-Werkstatt's Tone apps (Kitty,
 * Track303) built their sound on, rebuilt from native nodes and Klangwerk's
 * Param with Tone's own numbers and timing, so the sound stays the same
 * without the library: a current audio context (as
 * Tone's global one), composite nodes that connect and chain, Gain, Panner,
 * Delay, Compressor, Limiter, WaveShaper, Noise, FrequencyEnvelope and note
 * values. Ported from Tone.js 15.5 (MIT License, Copyright (c) 2014-2025
 * Yotam Mann), see THIRD_PARTY_NOTICES.md.
 */

/** Tone's look-ahead: live, "now" is this far ahead of the audio clock. */
const LOOKAHEAD_SECONDS = 0.1;

interface Sound {
  context: BaseAudioContext;
  offline: boolean;
  /** The tempo note values ("8n") are measured in. */
  bpm: number;
  /** While a step is scheduled offline: its place on the grid (before swing). */
  step: number | null;
  /** Offline: the start of the simulated clock's block the last step fell in, added up block by block as Tone does. */
  block: number;
}

let current: Sound | null = null;

export type { Sound };

/** Makes `context` the one new nodes are built in (as Tone.setContext); returns the sound before. */
export function useContext(context: BaseAudioContext): Sound | null {
  return swapSound({ context, offline: typeof OfflineAudioContext !== "undefined" && context instanceof OfflineAudioContext, bpm: 120, step: null, block: 0 });
}

/** Makes `next` current again (an offline render going on with its next stretch); returns the one before. */
export function swapSound(next: Sound | null): Sound | null {
  const previous = current;
  current = next;
  return previous;
}

export function currentSound(): Sound | null {
  return current;
}

function sound(): Sound {
  if (!current) throw new Error("no audio context yet");
  return current;
}

export function soundContext(): BaseAudioContext {
  return sound().context;
}

/** The tempo as Tone's transport reports it back: stored as ticks per second (192 per beat), so it can move by the last bit. */
export function setBpm(bpm: number): void {
  sound().bpm = ((1 / (60 / bpm / 192)) / 192) * 60;
}

export function bpm(): number {
  return sound().bpm;
}

/** Runs `schedule` as the step on the grid at `grid` (offline, "now" then is where Tone's simulated clock stood). */
export function atStep(grid: number, schedule: () => void): void {
  const state = sound();
  const previous = state.step;
  state.step = grid;
  try {
    schedule();
  } finally {
    state.step = previous;
  }
}

/**
 * What Tone calls now. Live: the audio clock plus the look-ahead. Offline:
 * Tone runs a simulated clock in blocks of 128 frames (adding up the block
 * length) and handles a step on the first block after it, so a value set
 * "now" lands just behind the note.
 */
export function now(): number {
  const state = sound();
  if (!state.offline) return state.context.currentTime + LOOKAHEAD_SECONDS;
  if (state.step === null) return state.context.currentTime;
  const block = 128 / state.context.sampleRate;
  if (state.step < state.block) state.block = 0;
  while (state.block + block <= state.step) state.block += block;
  return state.block + block;
}

/** Tone's context time: live the audio clock; offline its simulated clock, which stands at the block after a step while the step is scheduled. */
export function currentTime(): number {
  const state = sound();
  return state.offline && state.step !== null ? now() : state.context.currentTime;
}

/** A Param on `native` that knows Tone's "now"; `value` is set at once (now), as Tone's value setter does. */
export function param(native: AudioParam, units: ParamUnits, value?: number, convert = true): Param {
  const wrapped = new Param(sound().context, native, { units, convert, now });
  if (value !== undefined) wrapped.value = value;
  return wrapped;
}

/** A Param with a starting value set at time 0, as Tone's constructors set theirs. */
function startParam(native: AudioParam, units: ParamUnits, value: number, convert = true): Param {
  return new Param(sound().context, native, { units, convert, value, now });
}

// ---- note values --------------------------------------------------------------

/** Seconds of a number (seconds) or a note value ("4n", "8n", "16n", "8n.") at the current tempo. */
export function toSeconds(time: number | string): number {
  if (typeof time === "number") return time;
  const match = /^(\d+)n(\.?)$/i.exec(time);
  if (!match) throw new Error(`note value: ${time}`);
  const divisor = Number.parseInt(match[1]!, 10);
  const scalar = match[2] === "." ? 1.5 : 1;
  const beats = divisor === 1 ? 4 : 4 / divisor;
  return (60 / sound().bpm) * beats * scalar;
}

const SCALE_INDEX: Record<string, number> = { c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5, "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11 };

function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Hertz of a number (Hz) or a note name ("C1"), through Tone's period (1 / (1 / f)). */
export function toFrequency(frequency: number | string): number {
  let hertz: number;
  if (typeof frequency === "number") {
    hertz = frequency;
  } else {
    const match = /^([a-g](?:#|b)?)(-?\d+)$/i.exec(frequency);
    if (!match) throw new Error(`note: ${frequency}`);
    hertz = mtof(SCALE_INDEX[match[1]!.toLowerCase()]! + (Number.parseInt(match[2]!, 10) + 1) * 12);
  }
  return 1 / (1 / hertz);
}

/** Hertz of a MIDI note, as Tone.Frequency(midi, "midi").toFrequency(). */
export function midiFrequency(midi: number): number {
  return 1 / (1 / mtof(midi));
}

// ---- composite nodes --------------------------------------------------------------

export type Destination = SoundNode | AudioNode | AudioParam | Param;

function nativeOutput(source: SoundNode | AudioNode): AudioNode {
  let node: SoundNode | AudioNode = source;
  while (node instanceof SoundNode) node = node.output;
  return node;
}

function nativeInput(destination: Destination): AudioNode | AudioParam {
  let node: Destination | undefined = destination;
  while (node instanceof SoundNode || node instanceof Param) node = node instanceof Param ? node.param : node.input;
  if (!node) throw new Error("cannot connect to a node without input");
  return node;
}

/** Connects the output of `source` to the input of `destination` (as Tone.connect). */
export function connect(source: SoundNode | AudioNode, destination: Destination, outputNumber = 0, inputNumber = 0): void {
  const from = nativeOutput(source);
  const to = nativeInput(destination);
  if (to instanceof AudioParam) from.connect(to, outputNumber);
  else from.connect(to, outputNumber, inputNumber);
}

/** A piece of graph with an input and an output, built in the current context (as Tone.ToneAudioNode). */
export abstract class SoundNode {
  readonly context: BaseAudioContext = sound().context;
  abstract readonly input: AudioNode | SoundNode | undefined;
  abstract readonly output: AudioNode | SoundNode;

  get sampleTime(): number {
    return 1 / this.context.sampleRate;
  }

  now(): number {
    return now();
  }

  immediate(): number {
    return currentTime();
  }

  connect(destination: Destination, outputNumber = 0, inputNumber = 0): this {
    connect(this, destination, outputNumber, inputNumber);
    return this;
  }

  disconnect(destination?: Destination): this {
    const from = nativeOutput(this);
    if (destination === undefined) from.disconnect();
    else {
      const to = nativeInput(destination);
      if (to instanceof AudioParam) from.disconnect(to);
      else from.disconnect(to);
    }
    return this;
  }

  /** this → first → second → … */
  chain(...nodes: Destination[]): this {
    let previous: SoundNode | AudioNode = this;
    for (const node of nodes) {
      connect(previous, node);
      if (node instanceof SoundNode || node instanceof AudioNode) previous = node;
    }
    return this;
  }

  /** this → each of them. */
  fan(...nodes: Destination[]): this {
    for (const node of nodes) connect(this, node);
    return this;
  }

  dispose(): this {
    nativeOutput(this).disconnect();
    return this;
  }
}

export class Gain extends SoundNode {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly gain: Param;

  constructor(gain = 1, units: "gain" | "decibels" = "gain") {
    super();
    this.input = this.output = this.context.createGain();
    this.gain = startParam(this.output.gain, units, gain);
  }
}

/** A stereo panner fed in mono (as Tone.Panner). */
export class Panner extends SoundNode {
  readonly input: StereoPannerNode;
  readonly output: StereoPannerNode;
  readonly pan: Param;

  constructor(pan = 0) {
    super();
    this.input = this.output = this.context.createStereoPanner();
    this.pan = startParam(this.output.pan, "audioRange", pan);
    this.output.channelCount = 1;
    this.output.channelCountMode = "explicit";
  }
}

export class Delay extends SoundNode {
  readonly input: DelayNode;
  readonly output: DelayNode;
  readonly delayTime: Param;

  constructor(delayTime: number, maxDelay = 1) {
    super();
    this.input = this.output = this.context.createDelay(maxDelay);
    this.delayTime = startParam(this.output.delayTime, "time", delayTime);
  }
}

export interface CompressorOptions {
  threshold?: number;
  ratio?: number;
  attack?: number;
  release?: number;
  knee?: number;
}

export class Compressor extends SoundNode {
  readonly input: DynamicsCompressorNode;
  readonly output: DynamicsCompressorNode;
  readonly threshold: Param;
  readonly ratio: Param;
  readonly attack: Param;
  readonly release: Param;
  readonly knee: Param;

  constructor(options: CompressorOptions = {}) {
    super();
    const { threshold = -24, ratio = 12, attack = 0.003, release = 0.25, knee = 30 } = options;
    const node = this.context.createDynamicsCompressor();
    this.input = this.output = node;
    this.threshold = startParam(node.threshold, "decibels", threshold, false);
    this.attack = startParam(node.attack, "time", attack);
    this.release = startParam(node.release, "time", release);
    this.knee = startParam(node.knee, "decibels", knee, false);
    this.ratio = startParam(node.ratio, "positive", ratio, false);
  }
}

/** A hard compressor (as Tone.Limiter). */
export class Limiter extends Compressor {
  constructor(threshold = -12) {
    super({ ratio: 20, attack: 0.003, release: 0.01, threshold });
  }
}

export class WaveShaper extends SoundNode {
  readonly input: WaveShaperNode;
  readonly output: WaveShaperNode;

  constructor(mapping: (value: number, index: number) => number, length = 1024) {
    super();
    this.input = this.output = this.context.createWaveShaper();
    this.setMap(mapping, length);
  }

  set oversample(oversample: OverSampleType) {
    this.output.oversample = oversample;
  }

  /** The curve from `mapping` over [−1, 1] in `length` points. */
  setMap(mapping: (value: number, index: number) => number, length = 1024): this {
    const curve = new Float32Array(length);
    for (let index = 0; index < length; index += 1) curve[index] = mapping((index / (length - 1)) * 2 - 1, index);
    this.output.curve = curve;
    return this;
  }
}

// ---- noise -----------------------------------------------------------------------

const NOISE_SECONDS = 5;
const noiseCache: Partial<Record<"white" | "pink", AudioBuffer>> = {};

/** Tone.Noise's own five seconds of stereo noise, made once per page, the way Tone makes them. */
function toneNoise(context: BaseAudioContext, type: "white" | "pink"): AudioBuffer {
  const cached = noiseCache[type];
  if (cached) return cached;
  const length = 44_100 * NOISE_SECONDS;
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channelNumber = 0; channelNumber < 2; channelNumber += 1) {
    const channel = new Float32Array(length);
    if (type === "white") {
      for (let index = 0; index < length; index += 1) channel[index] = Math.random() * 2 - 1;
    } else {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let index = 0; index < length; index += 1) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        // Stored, then scaled in place: Tone rounds to 32 bits in between.
        channel[index] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        channel[index]! *= 0.11;
        b6 = white * 0.115926;
      }
    }
    buffer.copyToChannel(channel, channelNumber);
  }
  noiseCache[type] = buffer;
  return buffer;
}

/** Endless noise from a random place in the buffer (as Tone.Noise). */
export class Noise extends SoundNode {
  readonly input = undefined;
  readonly output: GainNode;
  private source: AudioBufferSourceNode | null = null;

  constructor(private readonly type: "white" | "pink" = "white") {
    super();
    this.output = this.context.createGain();
  }

  start(time = this.now()): this {
    const buffer = toneNoise(this.context, this.type);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = buffer.duration;
    source.connect(this.output);
    let offset = Math.max(Math.random() * (buffer.duration - 0.001), 0);
    if (Math.abs(offset - buffer.duration) < 1e-6) offset = 0;
    source.start(time, offset);
    this.source = source;
    return this;
  }

  override dispose(): this {
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source?.disconnect();
    return super.dispose();
  }
}

// ---- the 303's filter envelope ---------------------------------------------------------

export interface FrequencyEnvelopeOptions {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  baseFrequency: number;
  octaves: number;
  exponent: number;
}

/**
 * Tone.FrequencyEnvelope: an envelope (linear attack, exponential decay and
 * release) on a constant source, raised to `exponent` by a wave shaper and
 * scaled from `baseFrequency` up `octaves` octaves. Connect it to a
 * frequency whose own value is 0.
 */
export class FrequencyEnvelope extends SoundNode {
  readonly input = undefined;
  readonly output: GainNode;
  decay: number;
  private readonly attack: number;
  private readonly sustain: number;
  private readonly release: number;
  private readonly signal: Param;
  private readonly factor: Param;
  private readonly addend: Param;
  private base: number;
  private range: number;
  private readonly sources: ConstantSourceNode[];
  private readonly nodes: AudioNode[];
  private min: number;
  private max: number;

  constructor(options: FrequencyEnvelopeOptions) {
    super();
    this.attack = options.attack;
    this.decay = options.decay;
    this.sustain = options.sustain;
    this.release = options.release;
    this.base = toFrequency(options.baseFrequency);
    this.range = options.octaves;
    this.min = this.base;
    this.max = this.base * Math.pow(2, options.octaves);
    const context = this.context;
    const level = context.createConstantSource();
    this.signal = startParam(level.offset, "number", 0);
    const pow = context.createWaveShaper();
    const exponent = options.exponent;
    const curve = new Float32Array(8192);
    for (let index = 0; index < curve.length; index += 1) curve[index] = Math.pow(Math.abs((index / (curve.length - 1)) * 2 - 1), exponent);
    pow.curve = curve;
    const multiply = context.createGain();
    this.factor = startParam(multiply.gain, "gain", 1);
    this.factor.setValueAtTime(this.max - this.min, 0);
    const minimum = context.createConstantSource();
    this.addend = startParam(minimum.offset, "number", this.min);
    this.output = context.createGain();
    level.connect(pow).connect(multiply).connect(this.output);
    minimum.connect(this.output);
    level.start(0);
    minimum.start(0);
    this.sources = [level, minimum];
    this.nodes = [level, pow, multiply, minimum, this.output];
  }

  /**
   * The envelope's range, set "now" as Tone did: live that lands up to a few
   * tens of milliseconds into the note, offline one block after the step; the
   * 303's accents have always sounded with that.
   */
  set octaves(octaves: number) {
    this.range = octaves;
    this.max = this.base * Math.pow(2, octaves);
    this.setRange();
  }

  /** The lowest frequency; as in Tone, the range is set for the new minimum and then once more for the octaves on top. */
  set baseFrequency(frequency: number | string) {
    this.base = toFrequency(frequency);
    this.min = this.base;
    this.setRange();
    this.octaves = this.range;
  }

  private setRange(): void {
    this.addend.value = this.min;
    this.factor.value = this.max - this.min;
  }

  triggerAttack(time: number, velocity = 1): this {
    let attack = this.attack;
    const current = this.signal.getValueAtTime(time);
    if (current > 0) attack = (1 - current) / (1 / attack);
    if (attack < this.sampleTime) {
      this.signal.cancelScheduledValues(time);
      this.signal.setValueAtTime(velocity, time);
    } else {
      this.signal.linearRampTo(velocity, attack, time);
    }
    if (this.decay && this.sustain < 1) this.signal.exponentialApproachValueAtTime(velocity * this.sustain, time + attack, this.decay);
    return this;
  }

  triggerRelease(time: number = this.now()): this {
    if (this.signal.getValueAtTime(time) > 0) {
      if (this.release < this.sampleTime) this.signal.setValueAtTime(0, time);
      else this.signal.targetRampTo(0, this.release, time);
    }
    return this;
  }

  override dispose(): this {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.nodes.forEach((node) => node.disconnect());
    return this;
  }
}
