/* Shaper curves for WaveShaperNodes, and small number helpers. */

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Saturation that leaves quiet signals at about their level and rounds off
 * the loud ones: more drive means more grit, not more volume.
 */
export function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = 1 + amount * 9;
  const makeup = 1 + 0.25 * Math.sqrt(k - 1);
  const curve = new Float32Array(2048);
  for (let index = 0; index < curve.length; index += 1) {
    const x = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = (Math.tanh(k * x) / k) * makeup;
  }
  return curve;
}

/** A soft ceiling at 0.98: whatever reaches it, the output never clips. */
export function ceilingCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(4096);
  for (let index = 0; index < curve.length; index += 1) {
    const x = (index / (curve.length - 1)) * 4 - 2;
    const magnitude = Math.abs(x);
    const shaped = magnitude < 0.7 ? magnitude : 0.7 + 0.28 * Math.tanh((magnitude - 0.7) / 0.28);
    curve[index] = Math.sign(x) * Math.min(0.98, shaped);
  }
  return curve;
}

/** Fewer levels: the grit of an old sampler. */
export function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const levels = 2 ** bits;
  const curve = new Float32Array(8192);
  for (let index = 0; index < curve.length; index += 1) {
    const x = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = Math.round(x * levels) / levels;
  }
  return curve;
}
