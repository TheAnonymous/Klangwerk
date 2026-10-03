import type { Kit } from "./kit";

/*
 * Send effects. Each takes what the buses send into `input` and returns it,
 * at `level`, into `to` (usually the master's input).
 */

export interface Return {
  to: AudioNode;
  level: number;
}

/** A convolution reverb over `impulse` (see `hallImpulse`, `gatedImpulse`). */
export function createReverb(kit: Kit<string>, impulse: AudioBuffer, options: Return): { input: ConvolverNode; output: GainNode } {
  const input = kit.context.createConvolver();
  input.buffer = impulse;
  const output = kit.gain(options.level);
  input.connect(output).connect(options.to);
  return { input, output };
}

export interface EchoOptions extends Return {
  /** Seconds between repeats (set it from the tempo later on `delay.delayTime`). */
  time: number;
  feedback: number;
  /** The lowpass in the loop: every repeat gets darker. */
  tone: number;
  q: number;
}

/** A mono echo, darker with every repeat. */
export function createEcho(kit: Kit<string>, options: EchoOptions): { input: DelayNode; delay: DelayNode; tone: BiquadFilterNode; feedback: GainNode; output: GainNode } {
  const delay = kit.context.createDelay(2);
  delay.delayTime.value = options.time;
  const feedback = kit.gain(options.feedback);
  const tone = kit.filter("lowpass", options.tone, options.q);
  delay.connect(tone).connect(feedback).connect(delay);
  const output = kit.gain(options.level);
  tone.connect(output).connect(options.to);
  return { input: delay, delay, tone, feedback, output };
}

export interface PingPongOptions extends Return {
  feedback: number;
  tone: number;
}

/** An echo that bounces left, right, left …; set the time on both `left` and `right`. */
export function createPingPong(kit: Kit<string>, options: PingPongOptions): { input: GainNode; left: DelayNode; right: DelayNode; output: GainNode } {
  const context = kit.context;
  const left = context.createDelay(2);
  const right = context.createDelay(2);
  const input = kit.gain(1);
  const feedback = kit.gain(options.feedback);
  const tone = kit.filter("lowpass", options.tone);
  const merger = context.createChannelMerger(2);
  input.connect(left);
  left.connect(tone);
  tone.connect(merger, 0, 0);
  tone.connect(right);
  right.connect(merger, 0, 1);
  right.connect(feedback).connect(left);
  const output = kit.gain(options.level);
  merger.connect(output).connect(options.to);
  return { input, left, right, output };
}

export interface ChorusVoice {
  /** Base delay, LFO rate, LFO depth (seconds, Hz, seconds) and pan. */
  delay: number;
  rate: number;
  depth: number;
  pan: number;
}

export interface ChorusOptions {
  voices: readonly ChorusVoice[];
  dry: number;
  wet: number;
  to: AudioNode;
}

/** An insert chorus of slowly swaying delays, Juno-style: route a bus into `input` instead of the master. */
export function createChorus(kit: Kit<string>, options: ChorusOptions): { input: GainNode; dry: GainNode; wet: GainNode } {
  const context = kit.context;
  const input = kit.gain(1);
  const dry = kit.gain(options.dry);
  const wet = kit.gain(options.wet);
  input.connect(dry).connect(options.to);
  for (const voice of options.voices) {
    const line = context.createDelay(0.05);
    line.delayTime.value = voice.delay;
    const lfo = kit.osc("sine", voice.rate);
    const amount = kit.gain(voice.depth);
    lfo.connect(amount).connect(line.delayTime);
    lfo.start();
    const panner = context.createStereoPanner();
    panner.pan.value = voice.pan;
    input.connect(line).connect(panner).connect(wet);
  }
  wet.connect(options.to);
  return { input, dry, wet };
}
