import { describe, expect, it } from "vitest";
import { ceilingCurve } from "../src/curves";
import { audibleRange, encodePcm16Wav, encodeWav, trimmedLength } from "../src/wav";

function source(channels: number[][], sampleRate = 8_000) {
  return { numberOfChannels: channels.length, sampleRate, length: channels[0]!.length, getChannelData: (index: number) => Float32Array.from(channels[index]!) };
}

describe("wav", () => {
  it("writes a 16-bit header and clamps samples", () => {
    const wav = new DataView(encodeWav(source([[0, 2, -2, 0.5]])));
    expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe("RIFF");
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(40, true)).toBe(8);
    expect(wav.getInt16(46, true)).toBe(0x7fff);
    expect(wav.getInt16(48, true)).toBe(-0x8000);
  });

  it("trims silence at the end but keeps a breath", () => {
    const samples = new Array<number>(8_000).fill(0);
    samples[100] = 0.5;
    expect(trimmedLength(source([samples]))).toBe(100 + 2_000);
  });

  it("finds the audible part of a recording", () => {
    const left = new Int16Array(20_000);
    left[10_000] = 10_000;
    const pcm = { sampleRate: 8_000, left, right: new Int16Array(20_000) };
    expect(audibleRange(pcm)).toEqual({ start: 10_000 - 400, end: 10_001 + 4_000 });
    expect(audibleRange({ ...pcm, left: new Int16Array(20_000) })).toBeNull();
    expect(new DataView(encodePcm16Wav(pcm, 0, 10)).getUint32(40, true)).toBe(40);
  });

  it("never lets the master's ceiling reach full scale", () => {
    const curve = ceilingCurve();
    expect(Math.max(...curve.map(Math.abs))).toBeLessThanOrEqual(0.98);
    expect(curve[curve.length / 2 + 100]!).toBeCloseTo(((curve.length / 2 + 100) / (curve.length - 1)) * 4 - 2, 2);
  });
});
