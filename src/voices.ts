import type { Kit, VibratoOptions } from "./kit";

/*
 * Voices: little graphs a note builds, plays and frees. They take finished
 * numbers (peaks, frequencies, seconds), so each app keeps its own sound by
 * how it computes them: the engine has the shapes, the app has the taste.
 * Times inside a voice are offsets from the note's start.
 */

/** A filter: type, frequency, Q (0.7) and gain in dB (for shelves and peaks). */
export type FilterSpec = readonly [type: BiquadFilterType, frequency: number, q?: number, gain?: number];

function filterChain(kit: Kit<string>, specs: readonly FilterSpec[]): BiquadFilterNode[] {
  return specs.map(([type, frequency, q, gain]) => {
    const node = kit.filter(type, frequency, q);
    if (gain !== undefined) node.gain.value = gain;
    return node;
  });
}

function connectThrough(source: AudioNode, nodes: readonly AudioNode[], out: AudioNode): void {
  let last = source;
  for (const node of nodes) last = last.connect(node);
  last.connect(out);
}

// ---- hits: the parts drums and clicks are made of -------------------------

export interface ToneHit<W extends string = never> {
  wave: OscillatorType | W;
  frequency: number;
  /** A signal in cents added to the pitch (a wobble shared by several voices). */
  detuneBy?: AudioNode;
  /** The pitch falls to `to` within `time`: the thump of a kick or a tom. */
  drop?: { to: number; time: number };
  filters?: readonly FilterSpec[];
  peak: number;
  decay: number;
  attack?: number;
  /** The oscillator stops `length` + `tail` after the start (`length` is the decay unless set). */
  length?: number;
  tail?: number;
}

/** A struck oscillator. Returns its amp, for sends. */
export function toneHit<W extends string>(kit: Kit<W>, out: AudioNode, time: number, hit: ToneHit<W>): GainNode {
  const osc = kit.osc(hit.wave, hit.frequency);
  hit.detuneBy?.connect(osc.detune);
  if (hit.drop) {
    osc.frequency.setValueAtTime(hit.frequency, time);
    osc.frequency.exponentialRampToValueAtTime(hit.drop.to, time + hit.drop.time);
  }
  const amp = kit.gain();
  kit.strike(amp.gain, time, hit.peak, hit.decay, hit.attack);
  connectThrough(osc, [...filterChain(kit, hit.filters ?? []), amp], out);
  kit.stopAll([osc], time, time + (hit.length ?? hit.decay) + (hit.tail ?? 0.05));
  return amp;
}

export interface NoiseHit {
  /** How long the noise runs (it is silent long before, by the envelope). */
  duration: number;
  filters: readonly FilterSpec[];
  peak: number;
  decay: number;
  attack?: number;
}

/** A struck burst of filtered noise: hats, shakers, clicks, rattles, cymbals. Returns its amp. */
export function noiseHit(kit: Kit<string>, out: AudioNode, time: number, hit: NoiseHit): GainNode {
  const source = kit.noiseSource(time, hit.duration);
  const amp = kit.gain();
  kit.strike(amp.gain, time, hit.peak, hit.decay, hit.attack);
  connectThrough(source, [...filterChain(kit, hit.filters), amp], out);
  return amp;
}

// ---- drums ------------------------------------------------------------------

export interface KickOptions {
  /** The body falls from `top` to `bottom` within `sweep`. */
  top: number;
  bottom: number;
  sweep?: number;
  decay: number;
  level: number;
  /** A filtered square knock and a noise click keep the kick audible on phone speakers, which cannot play its body. */
  knock: { frequency?: number; level: number };
  click: { tone?: number; level: number };
}

export function kick(kit: Kit<string>, out: AudioNode, time: number, options: KickOptions): void {
  const { decay } = options;
  toneHit(kit, out, time, { wave: "sine", frequency: options.top, drop: { to: options.bottom, time: options.sweep ?? 0.08 }, peak: options.level, decay, attack: 0.001 });
  toneHit(kit, out, time, { wave: "square", frequency: options.knock.frequency ?? 120, filters: [["lowpass", 900]], peak: options.knock.level, decay: 0.03, attack: 0.001, length: decay });
  noiseHit(kit, out, time, { duration: 0.02, filters: [["highpass", options.click.tone ?? 3000]], peak: options.click.level, decay: 0.008, attack: 0.0005 });
}

export interface SnareOptions {
  /** The body falls from `top` to `bottom` in 50 ms. */
  top: number;
  bottom: number;
  bodyLevel: number;
  bodyDecay: number;
  /** The rattle: noise this long, through this filter. */
  noise: number;
  filter: FilterSpec;
  level: number;
  decay: number;
}

/** A body and a bright rattle. Returns both amps, for sends into a room. */
export function snare(kit: Kit<string>, out: AudioNode, time: number, options: SnareOptions): { body: GainNode; rattle: GainNode } {
  const body = toneHit(kit, out, time, { wave: "triangle", frequency: options.top, drop: { to: options.bottom, time: 0.05 }, peak: options.bodyLevel, decay: options.bodyDecay, length: 0.2, tail: 0 });
  const rattle = noiseHit(kit, out, time, { duration: options.noise, filters: [options.filter], peak: options.level, decay: options.decay });
  return { body, rattle };
}

export interface ClapOptions {
  frequency: number;
  /** Peak of each of the three bursts, and where each falls to. */
  burst: number;
  floor: number;
  /** Peak of the tail, and when it has died away. */
  level: number;
  tail: number;
}

/** Three quick bursts and a tail of bandpassed noise. Returns its amp. */
export function clap(kit: Kit<string>, out: AudioNode, time: number, options: ClapOptions): GainNode {
  const source = kit.noiseSource(time, 0.3);
  const tone = kit.filter("bandpass", options.frequency, 0.9);
  const amp = kit.gain();
  const g = amp.gain;
  g.setValueAtTime(0, time);
  for (const offset of [0, 0.011, 0.022]) {
    g.setValueAtTime(options.burst, time + offset);
    g.exponentialRampToValueAtTime(options.floor, time + offset + 0.009);
  }
  g.setValueAtTime(options.level, time + 0.033);
  g.exponentialRampToValueAtTime(0.0001, time + options.tail);
  source.connect(tone).connect(amp).connect(out);
  return amp;
}

/** A crash cymbal: bright noise with a shimmer, ringing for `decay`. */
export function crash(kit: Kit<string>, out: AudioNode, time: number, level: number, decay: number): GainNode {
  return noiseHit(kit, out, time, { duration: 1.8, filters: [["highpass", 4200], ["peaking", 8000, 1.2, 6]], peak: level, decay });
}

// ---- tuned voices -----------------------------------------------------------

/** A value change on an AudioParam: [kind, value, offset] or ["target", value, offset, timeConstant]. */
export type Automation =
  | readonly ["set" | "linear" | "exp", value: number, offset: number]
  | readonly ["target", value: number, offset: number, timeConstant: number];

export function automate(param: AudioParam, time: number, events: readonly Automation[]): void {
  for (const event of events) {
    const at = time + event[2];
    if (event[0] === "target") param.setTargetAtTime(event[1], at, event[3]);
    else if (event[0] === "set") param.setValueAtTime(event[1], at);
    else if (event[0] === "linear") param.linearRampToValueAtTime(event[1], at);
    else param.exponentialRampToValueAtTime(event[1], at);
  }
}

export interface OscSpec<W extends string = never> {
  wave: OscillatorType | W;
  frequency: number;
  detune?: number;
  /** A signal in cents added to the pitch (a wobble shared by several voices). */
  detuneBy?: AudioNode;
  /** A gain right after the oscillator. */
  level?: number;
  /** Past the filter, straight into the amp (a sub under a filtered saw). */
  direct?: boolean;
  vibrato?: VibratoOptions & { cents: number };
  /** Slides in from `from` Hz within `time` seconds (legato, 808 drops). */
  glide?: { from: number; time: number };
}

export type AmpSpec =
  /** Attack, sustain while held for `duration`, release (see `Kit.hold`). */
  | { hold: readonly [peak: number, duration: number, attack: number, sustain: number, decay: number, release: number] }
  /** Struck; the oscillators stop `length` (the decay unless set) + `tail` (0.05) after the start. */
  | { strike: readonly [peak: number, decay: number, attack?: number]; length?: number; tail?: number };

export interface Patch<W extends string = never> {
  oscs: readonly OscSpec<W>[];
  filter?: { type: BiquadFilterType; frequency: number; q?: number; env?: readonly Automation[] };
  amp: AmpSpec;
  /** How long the note is held (for vibrato). */
  duration: number;
}

/** Oscillators → filter → amp: the subtractive voice basses, pads, stabs, arps and leads are made of. */
export function voice<W extends string>(kit: Kit<W>, out: AudioNode, time: number, patch: Patch<W>): { amp: GainNode; end: number } {
  const oscs = patch.oscs.map((spec) => {
    const osc = kit.osc(spec.wave, spec.frequency, spec.detune);
    spec.detuneBy?.connect(osc.detune);
    return osc;
  });
  const tone = patch.filter ? kit.filter(patch.filter.type, patch.filter.frequency, patch.filter.q) : null;
  if (tone && patch.filter?.env) automate(tone.frequency, time, patch.filter.env);
  const amp = kit.gain();
  let end: number;
  if ("hold" in patch.amp) {
    end = kit.hold(amp.gain, time, ...patch.amp.hold);
  } else {
    const [peak, decay, attack] = patch.amp.strike;
    kit.strike(amp.gain, time, peak, decay, attack);
    end = time + (patch.amp.length ?? decay) + (patch.amp.tail ?? 0.05);
  }
  patch.oscs.forEach((spec, index) => {
    const osc = oscs[index]!;
    if (spec.vibrato) kit.vibrato(osc, time, patch.duration, spec.vibrato.cents, spec.vibrato);
    if (spec.glide) {
      osc.frequency.setValueAtTime(spec.glide.from, time);
      osc.frequency.exponentialRampToValueAtTime(spec.frequency, time + spec.glide.time);
    }
    let last: AudioNode = osc;
    if (spec.level !== undefined) last = last.connect(kit.gain(spec.level));
    last.connect(spec.direct || !tone ? amp : tone);
  });
  tone?.connect(amp);
  amp.connect(out);
  kit.stopAll(oscs, time, end);
  return { amp, end };
}

export interface FmBellOptions {
  frequency: number;
  /** Modulation index at the strike, in Hz of deviation; it falls to 8 % of the frequency. */
  index: number;
  /** Modulator frequency as a multiple of the carrier's (3.5 is a bell, 4 a glockenspiel). */
  ratio: number;
  level: number;
  decay: number;
}

/** Two-operator FM: a bell, a glockenspiel, a sparkle. */
export function fmBell(kit: Kit<string>, out: AudioNode, time: number, options: FmBellOptions): void {
  const { frequency, decay } = options;
  const carrier = kit.osc("sine", frequency);
  const modulator = kit.osc("sine", frequency * options.ratio);
  const index = kit.gain();
  index.gain.setValueAtTime(options.index, time);
  index.gain.exponentialRampToValueAtTime(frequency * 0.08, time + decay * 0.6);
  modulator.connect(index).connect(carrier.frequency);
  const amp = kit.gain();
  kit.strike(amp.gain, time, options.level, decay, 0.002);
  carrier.connect(amp).connect(out);
  kit.stopAll([carrier, modulator], time, time + decay + 0.05);
}

export interface FmPianoOptions {
  frequency: number;
  /** Modulation index at the strike (Hz of deviation); it settles at a quarter of the frequency. */
  index: number;
  level: number;
  duration: number;
}

/** A Rhodes-like electric piano: a 1:1 FM tone and a short tine two octaves up. */
export function fmPiano(kit: Kit<string>, out: AudioNode, time: number, options: FmPianoOptions): void {
  const { frequency, level } = options;
  const carrier = kit.osc("sine", frequency);
  const modulator = kit.osc("sine", frequency);
  const index = kit.gain();
  index.gain.setValueAtTime(options.index, time);
  index.gain.setTargetAtTime(frequency * 0.25, time, 0.12);
  modulator.connect(index).connect(carrier.frequency);
  const tine = kit.osc("sine", frequency * 4);
  const tineAmp = kit.gain();
  kit.strike(tineAmp.gain, time, level * 0.12, 0.08);
  tine.connect(tineAmp).connect(out);
  const amp = kit.gain();
  const end = kit.hold(amp.gain, time, level, options.duration, 0.003, 0.45, 0.8, 0.25);
  carrier.connect(amp).connect(out);
  kit.stopAll([carrier, modulator, tine], time, end);
}

// ---- effects ----------------------------------------------------------------

export interface RiserOptions {
  /** The bandpass sweeps from `from` to `to` Hz while the level rises to `peak`. */
  from?: number;
  to?: number;
  q?: number;
  peak?: number;
}

/** Rising noise until `end`; `cut` stops it early (at the drop). */
export function riser(kit: Kit<string>, out: AudioNode, start: number, end: number, options: RiserOptions = {}): { cut(time: number): void } {
  const { from = 300, to = 7000, q = 2.5, peak = 0.3 } = options;
  const length = Math.max(0.1, end - start);
  // The noise runs on past the end, so a riser held longer than planned does not stop by itself.
  const source = kit.noiseSource(start, length + 8);
  const tone = kit.filter("bandpass", from, q);
  tone.frequency.setValueAtTime(from, start);
  tone.frequency.exponentialRampToValueAtTime(to, end);
  const amp = kit.gain();
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(peak, end);
  source.connect(tone).connect(amp).connect(out);
  return {
    cut: (time: number) => {
      amp.gain.cancelScheduledValues(time);
      amp.gain.setValueAtTime(amp.gain.value, time);
      amp.gain.linearRampToValueAtTime(0, time + 0.02);
      try {
        source.stop(time + 0.05);
      } catch {
        // Already stopped.
      }
    },
  };
}
