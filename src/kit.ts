import { noiseBuffer } from "./buffers";

/*
 * The building blocks every voice is made of: nodes with their settings in
 * one call, envelopes, and the start/stop bookkeeping. Every note builds its
 * own little graph from these and frees it when it has rung out.
 */

export interface KitOptions<W extends string> {
  /** Seed of the noise every drum and riser reads from. */
  noiseSeed?: number;
  /** Periodic waves the voices can ask for by name, next to the built-in oscillator types. */
  waves?: Record<W, PeriodicWave>;
}

export interface VibratoOptions {
  /** Seconds before the vibrato starts, and how long it takes to reach its depth. */
  delay?: number;
  rise?: number;
  rate?: number;
  /** How long the LFO runs past the note. */
  tail?: number;
}

export class Kit<W extends string = never> {
  readonly noise: AudioBuffer;
  private readonly waves: Partial<Record<W, PeriodicWave>>;

  constructor(readonly context: BaseAudioContext, options: KitOptions<W> = {}) {
    this.noise = noiseBuffer(context, options.noiseSeed ?? 22_222);
    this.waves = options.waves ?? {};
  }

  gain(value = 0): GainNode {
    const node = this.context.createGain();
    node.gain.value = value;
    return node;
  }

  filter(type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode {
    const node = this.context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
  }

  osc(type: OscillatorType | W, frequency: number, detune = 0): OscillatorNode {
    const node = this.context.createOscillator();
    const wave = this.waves[type as W];
    if (wave) node.setPeriodicWave(wave);
    else node.type = type as OscillatorType;
    node.frequency.value = frequency;
    node.detune.value = detune;
    return node;
  }

  /** Noise from `time` for `duration`, read from a different place of the buffer each time. */
  noiseSource(time: number, duration: number): AudioBufferSourceNode {
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const offset = ((time * 7.31) % 1.5) + 0.01;
    source.start(time, offset, duration + 0.05);
    return source;
  }

  /** Attack to `peak`, fall to zero over `decay`: a struck sound. */
  strike(param: AudioParam, time: number, peak: number, decay: number, attack = 0.002): void {
    param.setValueAtTime(0, time);
    param.linearRampToValueAtTime(peak, time + attack);
    param.exponentialRampToValueAtTime(0.0001, time + attack + decay);
  }

  /** Attack, sustain while held, release: a played note. Returns when it is silent. */
  hold(param: AudioParam, time: number, peak: number, duration: number, attack: number, sustain: number, decay: number, release: number): number {
    param.setValueAtTime(0, time);
    param.linearRampToValueAtTime(peak, time + attack);
    param.setTargetAtTime(peak * sustain, time + attack, Math.max(0.005, decay / 3));
    const end = time + Math.max(duration, attack + 0.01);
    param.setTargetAtTime(0, end, Math.max(0.005, release / 4));
    return end + release * 1.6;
  }

  /** Starts the oscillators at `time` (buffer sources start themselves) and stops all at `end`. */
  stopAll(nodes: readonly (AudioScheduledSourceNode | null)[], time: number, end: number): void {
    for (const node of nodes) {
      if (!node) continue;
      if (!(node instanceof AudioBufferSourceNode)) node.start(time);
      node.stop(end);
    }
  }

  /** A delayed vibrato of `cents` on the oscillator's pitch, only on notes long enough for it. */
  vibrato(osc: OscillatorNode, time: number, duration: number, cents: number, options: VibratoOptions = {}): void {
    const { delay = 0.2, rise = 0.2, rate = 5.4, tail = 0.3 } = options;
    if (duration < delay + 0.05) return;
    const lfo = this.osc("sine", rate);
    const depth = this.gain();
    depth.gain.setValueAtTime(0, time);
    depth.gain.linearRampToValueAtTime(0, time + delay);
    depth.gain.linearRampToValueAtTime(cents, time + delay + rise);
    lfo.connect(depth).connect(osc.detune);
    this.stopAll([lfo], time, time + duration + tail);
  }
}
