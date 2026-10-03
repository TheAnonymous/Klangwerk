/*
 * The AudioWorklet that copies the master's samples off the audio thread in
 * blocks. It is loaded from a Blob, so the engine needs no bundler support;
 * that takes `script-src blob:` in the page's CSP.
 */
const PROCESSOR_SOURCE = `class MasterRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 8192;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.filled = 0;
    this.recording = true;
    this.port.onmessage = (event) => {
      if (event.data !== "stop") return;
      if (this.filled > 0) this.port.postMessage({ left: this.left.slice(0, this.filled), right: this.right.slice(0, this.filled) });
      this.recording = false;
      this.port.postMessage({ done: true });
    };
  }

  process(inputs) {
    if (!this.recording) return false;
    const input = inputs[0] || [];
    const left = input[0];
    const right = input[1] || input[0];
    const frames = left ? left.length : 128;
    for (let index = 0; index < frames; index += 1) {
      this.left[this.filled] = left ? left[index] : 0;
      this.right[this.filled] = right ? right[index] : 0;
      this.filled += 1;
      if (this.filled === this.size) {
        this.port.postMessage({ left: this.left, right: this.right }, [this.left.buffer, this.right.buffer]);
        this.left = new Float32Array(this.size);
        this.right = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("klangwerk-recorder", MasterRecorder);
`;

let processorUrl: string | null = null;

/** Longest live recording: 10 minutes of 16-bit stereo is about 115 MB, plus as much again for the WAV; enough for a phone. */
export const MAX_RECORDING_SECONDS = 10 * 60;

const PROCESSOR = "klangwerk-recorder";

const loadedContexts = new WeakSet<BaseAudioContext>();

export interface Recording {
  sampleRate: number;
  left: Int16Array;
  right: Int16Array;
}

/**
 * Records what leaves the master, as the speakers get it, into 16-bit PCM.
 * An AudioWorklet copies the samples off the audio thread in blocks, so the
 * recording is lossless and cannot glitch the music.
 */
export class MasterRecorder {
  private node: AudioWorkletNode | null = null;
  private silent: GainNode | null = null;
  private source: AudioNode | null = null;
  private chunks: { left: Int16Array; right: Int16Array }[] = [];
  private frames = 0;
  private stopping: ((recording: Recording) => void) | null = null;
  private sampleRate = 44_100;

  constructor(private readonly onLimit: () => void) {}

  static supported(): boolean {
    return typeof AudioWorkletNode === "function";
  }

  get active(): boolean {
    return this.node !== null;
  }

  get seconds(): number {
    return this.frames / this.sampleRate;
  }

  async start(context: AudioContext, source: AudioNode): Promise<void> {
    if (this.node) return;
    if (!loadedContexts.has(context)) {
      processorUrl ??= URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "text/javascript" }));
      await context.audioWorklet.addModule(processorUrl);
      loadedContexts.add(context);
    }
    this.sampleRate = context.sampleRate;
    this.chunks = [];
    this.frames = 0;
    const node = new AudioWorkletNode(context, PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.port.onmessage = (event: MessageEvent<{ left?: Float32Array; right?: Float32Array; done?: boolean }>) => this.receive(event.data);
    // A worklet only runs while something pulls it; a muted path to the output does.
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent).connect(context.destination);
    this.node = node;
    this.silent = silent;
    this.source = source;
  }

  stop(): Promise<Recording> {
    const node = this.node;
    if (!node) return Promise.resolve(this.collect());
    return new Promise((resolve) => {
      this.stopping = resolve;
      node.port.postMessage("stop");
      // A suspended context (a call took the sound) runs no worklet that could
      // answer; keep what arrived so far instead of waiting forever.
      setTimeout(() => {
        if (this.stopping === resolve) this.receive({ done: true });
      }, 800);
    });
  }

  private receive(data: { left?: Float32Array; right?: Float32Array; done?: boolean }): void {
    if (data.left && data.right) {
      this.chunks.push({ left: toPcm(data.left), right: toPcm(data.right) });
      this.frames += data.left.length;
      if (this.seconds >= MAX_RECORDING_SECONDS && !this.stopping) this.onLimit();
    }
    if (!data.done) return;
    if (this.node) this.source?.disconnect(this.node);
    this.node?.disconnect();
    this.silent?.disconnect();
    this.node = null;
    this.silent = null;
    this.source = null;
    const resolve = this.stopping;
    this.stopping = null;
    resolve?.(this.collect());
  }

  private collect(): Recording {
    const left = new Int16Array(this.frames);
    const right = new Int16Array(this.frames);
    let offset = 0;
    for (const chunk of this.chunks) {
      left.set(chunk.left, offset);
      right.set(chunk.right, offset);
      offset += chunk.left.length;
    }
    this.chunks = [];
    this.frames = 0;
    return { sampleRate: this.sampleRate, left, right };
  }
}

function toPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return pcm;
}
