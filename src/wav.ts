/* Offline renders and live recordings as 16-bit WAV. */

export interface PcmSource {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/** Length up to the last sample above `thresholdDb`, plus a short breath, never below `minimumLength`. */
export function trimmedLength(source: PcmSource, minimumLength = 0, thresholdDb = -66): number {
  const threshold = 10 ** (thresholdDb / 20);
  const channels = Array.from({ length: source.numberOfChannels }, (_, index) => source.getChannelData(index));
  let last = 0;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (channels.some((channel) => Math.abs(channel[index] ?? 0) > threshold)) {
      last = index;
      break;
    }
  }
  const breath = Math.round(source.sampleRate * 0.25);
  return Math.min(source.length, Math.max(minimumLength, last + breath));
}

/** 16-bit PCM WAV with a 20 ms fade at the end so a trimmed tail never clicks. */
export function encodeWav(source: PcmSource, length = source.length): ArrayBuffer {
  const channels = Math.max(1, source.numberOfChannels);
  const frames = Math.max(0, Math.min(length, source.length));
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, source.sampleRate, true);
  view.setUint32(28, source.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);

  const data = Array.from({ length: channels }, (_, index) => source.getChannelData(Math.min(index, source.numberOfChannels - 1)));
  const fadeFrames = Math.min(frames, Math.round(source.sampleRate * 0.02));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    const fade = frame >= frames - fadeFrames ? (frames - frame) / Math.max(1, fadeFrames) : 1;
    for (const channel of data) {
      const sample = Math.max(-1, Math.min(1, (channel[frame] ?? 0) * fade));
      view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}


export interface Pcm16 {
  sampleRate: number;
  left: Int16Array;
  right: Int16Array;
}

/**
 * The audible part of a live recording: from shortly before the first to
 * shortly after the last sample above `thresholdDb`; `null` when all silent.
 */
export function audibleRange(pcm: Pcm16, thresholdDb = -66): { start: number; end: number } | null {
  const threshold = Math.max(1, Math.round(10 ** (thresholdDb / 20) * 0x7fff));
  const loud = (index: number) => Math.abs(pcm.left[index]!) > threshold || Math.abs(pcm.right[index]!) > threshold;
  let first = 0;
  while (first < pcm.left.length && !loud(first)) first += 1;
  if (first === pcm.left.length) return null;
  let last = pcm.left.length - 1;
  while (last > first && !loud(last)) last -= 1;
  const lead = Math.round(pcm.sampleRate * 0.05);
  const breath = Math.round(pcm.sampleRate * 0.5);
  return { start: Math.max(0, first - lead), end: Math.min(pcm.left.length, last + 1 + breath) };
}

/** 16-bit stereo WAV of `pcm` between `start` and `end`. */
export function encodePcm16Wav(pcm: Pcm16, start = 0, end = pcm.left.length): ArrayBuffer {
  const frames = Math.max(0, Math.min(end, pcm.left.length) - Math.max(0, start));
  const dataBytes = frames * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = Math.max(0, start); frame < Math.max(0, start) + frames; frame += 1) {
    view.setInt16(offset, pcm.left[frame]!, true);
    view.setInt16(offset + 2, pcm.right[frame]!, true);
    offset += 4;
  }
  return buffer;
}
