/*
 * Sample buffers made from a seeded generator (Park–Miller), so every render
 * of the same music is the same down to the sample: noise for drums and
 * risers, and impulse responses for halls and gated rooms.
 */

const MODULUS = 2_147_483_647;
const MULTIPLIER = 16_807;

/** Two seconds (or `seconds`) of white noise, mono. */
export function noiseBuffer(context: BaseAudioContext, seed: number, seconds = 2): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    seed = (seed * MULTIPLIER) % MODULUS;
    data[index] = (seed / MODULUS) * 2 - 1;
  }
  return buffer;
}

export interface HallOptions {
  seed?: number;
  /** One-pole damping at the start, and how much it grows to the end: later reflections get darker. */
  damping?: number;
  darkening?: number;
  /** Seconds of silence before the first reflection. */
  predelay?: number;
  /** How steeply the tail falls (the exponent at the end). */
  decay?: number;
}

/** A stereo hall: decaying noise that gets darker over time. */
export function hallImpulse(context: BaseAudioContext, seconds: number, options: HallOptions = {}): AudioBuffer {
  const { seed: start = 1_234_567, damping: low = 0.1, darkening = 0.8, predelay: gap = 0.022, decay = 4 } = options;
  const rate = context.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = context.createBuffer(2, length, rate);
  let seed = start;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let smooth = 0;
    for (let index = 0; index < length; index += 1) {
      seed = (seed * MULTIPLIER) % MODULUS;
      const white = (seed / MODULUS) * 2 - 1;
      const damping = low + darkening * (index / length);
      smooth += (white - smooth) * (1 - damping);
      const predelay = index < rate * gap ? 0 : 1;
      data[index] = smooth * predelay * Math.exp((-decay * index) / length);
    }
  }
  return buffer;
}

/** A burst of dense reflections that stays loud and then stops dead: the gated room of an 80s snare. */
export function gatedImpulse(context: BaseAudioContext, seconds: number, seed = 7_654_321): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.floor(rate * seconds);
  const fade = Math.floor(rate * 0.012);
  const buffer = context.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      seed = (seed * MULTIPLIER) % MODULUS;
      const white = (seed / MODULUS) * 2 - 1;
      const tail = index > length - fade ? (length - index) / fade : 1;
      data[index] = white * 0.32 * (1 - 0.35 * (index / length)) * tail;
    }
  }
  return buffer;
}

/** A periodic wave from harmonic amplitudes (the first is the fundamental). */
export function harmonicWave(context: BaseAudioContext, harmonics: readonly number[]): PeriodicWave {
  const real = new Float32Array(harmonics.length + 1);
  const imag = new Float32Array(harmonics.length + 1);
  harmonics.forEach((amplitude, index) => { imag[index + 1] = amplitude; });
  return context.createPeriodicWave(real, imag);
}

/** A pulse wave of `width` (0.5 is a square), from its first `harmonics` partials. */
export function pulseWave(context: BaseAudioContext, width: number, harmonics = 24): PeriodicWave {
  return harmonicWave(context, Array.from({ length: harmonics }, (_, index) => (2 / (Math.PI * (index + 1))) * Math.sin(Math.PI * (index + 1) * width)));
}
