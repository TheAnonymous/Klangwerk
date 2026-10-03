import { ceilingCurve, clamp01 } from "./curves";

/*
 * The mixing desk: channel buses (drive, sidechain pump, level, sends) and a
 * master that never clips: the app's own inserts, a gate for starting and
 * stopping, a gentle compressor, a limiter, the volume and a soft ceiling.
 */

export interface DynamicsSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}

/** A piece of graph with one way in and one way out. */
export interface Insert {
  input: AudioNode;
  output: AudioNode;
}

export interface MasterOptions {
  destination?: AudioNode;
  /** What runs between the input and the dynamics, in order; `"gate"` is where the gate sits (at the end if missing). */
  chain?: readonly (AudioNode | Insert | "gate")[];
  /** Whether the gate starts open. */
  open?: boolean;
  compressor?: Partial<DynamicsSettings>;
  /** The browser's compressor adds its own makeup gain; this takes it back out. */
  makeup?: number;
  limiter?: Partial<DynamicsSettings>;
}

const COMPRESSOR: DynamicsSettings = { threshold: -14, knee: 8, ratio: 3, attack: 0.006, release: 0.2 };
const LIMITER: DynamicsSettings = { threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.08 };

function dynamics(context: BaseAudioContext, settings: DynamicsSettings): DynamicsCompressorNode {
  const node = context.createDynamicsCompressor();
  node.threshold.value = settings.threshold;
  node.knee.value = settings.knee;
  node.ratio.value = settings.ratio;
  node.attack.value = settings.attack;
  node.release.value = settings.release;
  return node;
}

const entry = (node: AudioNode | Insert): AudioNode => ("input" in node && "output" in node ? node.input : node as AudioNode);
const exit = (node: AudioNode | Insert): AudioNode => ("input" in node && "output" in node ? node.output : node as AudioNode);

export class Master {
  /** Where buses and effect returns go. */
  readonly input: GainNode;
  readonly gate: GainNode;
  /** What the listener hears, for the live recorder. */
  readonly output: AudioNode;
  private readonly volumeGain: GainNode;

  constructor(readonly context: BaseAudioContext, options: MasterOptions = {}) {
    this.input = context.createGain();
    this.gate = context.createGain();
    this.gate.gain.value = options.open ? 1 : 0;
    const compressor = dynamics(context, { ...COMPRESSOR, ...options.compressor });
    const makeup = context.createGain();
    makeup.gain.value = options.makeup ?? 0.5;
    const limiter = dynamics(context, { ...LIMITER, ...options.limiter });
    this.volumeGain = context.createGain();
    const ceiling = context.createWaveShaper();
    ceiling.curve = ceilingCurve();

    const chain = options.chain ?? [];
    let last: AudioNode = this.input;
    for (const item of chain.includes("gate") ? chain : [...chain, "gate" as const]) {
      const node = item === "gate" ? this.gate : item;
      last.connect(entry(node));
      last = exit(node);
    }
    last.connect(compressor).connect(makeup).connect(limiter).connect(this.volumeGain).connect(ceiling).connect(options.destination ?? context.destination);
    this.output = ceiling;
  }

  /** 0..1, on a curve that feels even to the ear. */
  setVolume(volume: number, time = this.context.currentTime): void {
    this.volumeGain.gain.setTargetAtTime(clamp01(volume) ** 1.6, time, 0.02);
  }

  /** Opens the gate at `time`, at once or fading in over `fade` seconds. */
  open(time: number, fade = 0): void {
    const gain = this.gate.gain;
    gain.cancelScheduledValues(time);
    if (fade > 0) {
      gain.setValueAtTime(gain.value, time);
      gain.linearRampToValueAtTime(1, time + fade);
    } else {
      gain.setValueAtTime(1, time);
    }
  }

  /** Closes the gate at `time`; what still rings fades with `timeConstant`. */
  close(time: number, timeConstant = 0.025): void {
    this.gate.gain.cancelScheduledValues(time);
    this.gate.gain.setTargetAtTime(0, time, timeConstant);
  }
}

export interface ChannelBus<S extends string = never> {
  input: GainNode;
  drive: WaveShaperNode | null;
  /** The sidechain's gain: `duck` it on every kick. */
  pump: GainNode;
  output: GainNode;
  sends: Record<S, GainNode>;
}

export interface BusOptions<S extends string> {
  level: number;
  /** A shaper after the input for grit (set its curve with `driveCurve`). */
  drive?: boolean;
  to: AudioNode;
  /** Effect inputs this bus sends into (each send starts at 1). */
  sends?: Record<S, AudioNode>;
}

/** input → (drive) → pump → output → `to`, and output → a send per effect. */
export function createBus<S extends string = never>(context: BaseAudioContext, options: BusOptions<S>): ChannelBus<S> {
  const input = context.createGain();
  const drive = options.drive ? context.createWaveShaper() : null;
  const pump = context.createGain();
  const output = context.createGain();
  output.gain.value = options.level;
  const targets = Object.entries(options.sends ?? {}) as [S, AudioNode][];
  const sends = Object.fromEntries(targets.map(([name]) => [name, context.createGain()])) as Record<S, GainNode>;
  if (drive) input.connect(drive).connect(pump);
  else input.connect(pump);
  pump.connect(output);
  output.connect(options.to);
  for (const [name, target] of targets) output.connect(sends[name]).connect(target);
  return { input, drive, pump, output, sends };
}

export interface DuckOptions {
  /** How fast it goes down, how long it stays, how fast it swells back (time constants in seconds). */
  attack?: number;
  hold?: number;
  release?: number;
}

/** Sidechain: pushes a gain down by `depth` and lets it swell back, the breathing under a kick. */
export function duck(param: AudioParam, time: number, depth: number, options: DuckOptions = {}): void {
  const { attack = 0.004, hold = 0.035, release = 0.08 } = options;
  param.cancelScheduledValues(time);
  param.setTargetAtTime(1 - depth, time, attack);
  param.setTargetAtTime(1, time + hold, release);
}
