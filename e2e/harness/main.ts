import * as Tone from "tone";
import { connect, FrequencyEnvelope, LeanEq3, midiFrequency, setBpm, swapSound, toFrequency, toSeconds, useContext } from "../../src/tone/index";
import {
  Clock, createBus, createChorus, createPingPong, createReverb, clap, crash, driveCurve, duck, fmBell, hallImpulse, kick, Kit, Master, MasterRecorder, midiToHz,
  noiseHit, Param, pulseWave, renderInChunks, snare, Transport, voice,
} from "../../src/index";

/* A small song through the whole engine, for the browser tests. */

function song(context: BaseAudioContext): Transport {
  const kit = new Kit(context, { waves: { pulse: pulseWave(context, 0.3) } });
  const master = new Master(context);
  const reverb = createReverb(kit, hallImpulse(context, 2), { level: 0.8, to: master.input });
  const echo = createPingPong(kit, { feedback: 0.4, tone: 3000, level: 0.6, to: master.input });
  for (const line of [echo.left, echo.right]) line.delayTime.value = 0.375;
  const chorus = createChorus(kit, { voices: [{ delay: 0.0075, rate: 0.53, depth: 0.0022, pan: -0.8 }, { delay: 0.011, rate: 0.79, depth: 0.0027, pan: 0.8 }], dry: 1, wet: 0.4, to: master.input });
  const drums = createBus(context, { level: 0.8, drive: true, to: master.input, sends: { reverb: reverb.input } });
  drums.drive!.curve = driveCurve(0.3);
  const synth = createBus(context, { level: 0.4, to: chorus.input, sends: { reverb: reverb.input, echo: echo.input } });
  master.open(0);
  const transport = new Transport({
    stepDuration: () => 0.125,
    step: (step, time) => {
      const sixteenth = step % 16;
      if (sixteenth % 4 === 0) {
        kick(kit, drums.input, time, { top: 160, bottom: 50, decay: 0.32, level: 0.9, knock: { level: 0.14 }, click: { level: 0.25 } });
        duck(synth.pump.gain, time, 0.5);
      }
      if (sixteenth === 4 || sixteenth === 12) {
        snare(kit, drums.input, time, { top: 200, bottom: 160, bodyLevel: 0.5, bodyDecay: 0.1, noise: 0.22, filter: ["highpass", 1400], level: 0.55, decay: 0.16 });
        clap(kit, drums.input, time, { frequency: 1200, burst: 0.7, floor: 0.1, level: 0.5, tail: 0.22 });
      }
      noiseHit(kit, drums.input, time, { duration: 0.08, filters: [["highpass", 7600]], peak: sixteenth % 2 ? 0.15 : 0.25, decay: 0.036, attack: 0.001 });
      if (sixteenth === 0 && step % 32 === 0) crash(kit, drums.input, time, 0.3, 1.6);
      if (sixteenth % 2 === 0) {
        const frequency = midiToHz(sixteenth % 8 === 0 ? 33 : 45);
        voice(kit, synth.input, time, {
          oscs: [{ wave: "sawtooth", frequency }, { wave: "sine", frequency: frequency / 2, level: 0.5, direct: true }],
          filter: { type: "lowpass", frequency: 520, q: 3.5, env: [["set", 2600, 0], ["target", 520, 0.004, 0.06]] },
          amp: { hold: [0.8, 0.1, 0.002, 0.65, 0.1, 0.04] },
          duration: 0.1,
        });
      }
      if (sixteenth === 0) {
        voice(kit, synth.input, time, {
          oscs: [{ wave: "pulse", frequency: midiToHz(69), vibrato: { cents: 14 } }, { wave: "square", frequency: midiToHz(57), detune: 4 }],
          filter: { type: "lowpass", frequency: 3800, q: 0.9 },
          amp: { hold: [0.3, 1, 0.004, 0.75, 0.12, 0.07] },
          duration: 1,
        });
      }
      if (sixteenth === 10) fmBell(kit, synth.input, time, { frequency: midiToHz(81), index: midiToHz(81) * 2, ratio: 3.5, level: 0.3, decay: 0.45 });
    },
  });
  transport.begin(context, 0.02);
  return transport;
}

async function render(seconds: number) {
  const context = new OfflineAudioContext(2, Math.ceil(seconds * 44_100), 44_100);
  const transport = song(context);
  const buffer = await renderInChunks(context, (until) => transport.renderUntil(until), seconds);
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  let peak = 0;
  let sum = 0;
  let nonFinite = 0;
  for (const data of channels) {
    for (const sample of data) {
      if (!Number.isFinite(sample)) nonFinite += 1;
      else {
        peak = Math.max(peak, Math.abs(sample));
        sum += sample * sample;
      }
    }
  }
  const bytes = new Uint8Array(channels[0]!.length * 8);
  bytes.set(new Uint8Array(channels[0]!.buffer), 0);
  bytes.set(new Uint8Array(channels[1]!.buffer), channels[0]!.length * 4);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { peak, rmsDb: 20 * Math.log10(Math.sqrt(sum / (channels[0]!.length * 2))), nonFinite, digest, steps: transport.step, channels };
}

/** Renders twice: how far apart are the two (Chromium sums a node's inputs in no fixed order)? */
async function renderTwice(seconds: number) {
  const { channels: first, ...summary } = await render(seconds);
  const { channels: second } = await render(seconds);
  let difference = 0;
  first.forEach((data, channel) => data.forEach((sample, index) => { difference = Math.max(difference, Math.abs(sample - second[channel]![index]!)); }));
  return { ...summary, difference };
}

async function clockTicks(ms: number): Promise<number> {
  let ticks = 0;
  const clock = new Clock(() => { ticks += 1; });
  clock.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  clock.dispose();
  return ticks;
}

async function record(ms: number) {
  const context = new AudioContext();
  await context.resume();
  const osc = context.createOscillator();
  const level = context.createGain();
  level.gain.value = 0.5;
  osc.connect(level).connect(context.destination);
  osc.start();
  const recorder = new MasterRecorder(() => undefined);
  await recorder.start(context, level);
  await new Promise((resolve) => setTimeout(resolve, ms));
  const recording = await recorder.stop();
  await context.close();
  return { frames: recording.left.length, peak: Math.max(...recording.left.map(Math.abs)) };
}

const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
Object.assign(window, { klangwerk: { renderTwice, clockTicks, record, violations } });
document.documentElement.dataset.ready = "1";


/* ---- Param against Tone.Param: the same automation, the same values ------- */

/** A repeatable random sequence (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Automatable = Record<string, (...args: number[]) => unknown>;
type Units = "number" | "frequency" | "decibels" | "gain";

/** One random automation call on `param` at `time`, drawn from `next`. */
function step(param: Automatable, time: number, units: Units, next: () => number): void {
  const pick = (low: number, high: number) => low + next() * (high - low);
  const value = () => (units === "frequency" ? pick(40, 8000) : units === "decibels" ? pick(-40, 0) : pick(0, 1));
  switch (Math.floor(next() * 11)) {
    case 0: param.setValueAtTime!(value(), time); break;
    case 1: param.linearRampToValueAtTime!(value(), time + pick(0.01, 0.3)); break;
    case 2: param.exponentialRampToValueAtTime!(value(), time + pick(0.01, 0.3)); break;
    case 3: param.setTargetAtTime!(value(), time, pick(0.005, 0.2)); break;
    case 4: param.cancelAndHoldAtTime!(time); break;
    case 5: param.cancelScheduledValues!(time + pick(0, 0.2)); break;
    case 6: param.rampTo!(value(), pick(0.01, 0.3), time); break;
    case 7: param.linearRampTo!(value(), pick(0.01, 0.3), time); break;
    case 8: param.exponentialRampTo!(value(), pick(0.01, 0.3), time); break;
    case 9: param.targetRampTo!(value(), pick(0.01, 0.3), time); break;
    default: param.setRampPoint!(time);
  }
}

/** Plays seed's 40 random calls on the param `make` builds; returns what it reports and what it renders. */
async function renderSequence(seed: number, make: (context: OfflineAudioContext, offset: AudioParam, units: Units) => Automatable) {
  const units = (["number", "frequency", "decibels", "gain"] as const)[seed % 4]!;
  const context = new OfflineAudioContext(1, 44_100 * 3, 44_100);
  const source = context.createConstantSource();
  const param = make(context, source.offset, units);
  const next = random(seed);
  const values: number[] = [];
  let time = 0;
  for (let index = 0; index < 40; index += 1) {
    time += next() * 0.08;
    step(param, time, units, next);
    values.push(Number(param.getValueAtTime!(time + 0.013)));
  }
  source.connect(context.destination);
  source.start(0);
  return { values, samples: (await context.startRendering()).getChannelData(0) };
}

const ourParam = (context: OfflineAudioContext, offset: AudioParam, units: Units) => new Param(context, offset, { units, value: 0.5 }) as unknown as Automatable;
const relative = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(a));

/** Plays the same 40 random calls on both and compares what they report and what they render. */
async function paramConformance(seeds: number) {
  let worstValue = 0;
  let worstSample = 0;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const ours = await renderSequence(seed, ourParam);
    const theirs = await renderSequence(seed, (context, offset, units) => new Tone.Param({ context: new Tone.Context(context), param: offset, units, value: 0.5 } as never) as unknown as Automatable);
    ours.values.forEach((value, index) => { worstValue = Math.max(worstValue, relative(value, theirs.values[index]!)); });
    ours.samples.forEach((value, index) => { worstSample = Math.max(worstSample, relative(value, theirs.samples[index]!)); });
  }
  return { worstValue, worstSample };
}

/** The same sequences with the browser's cancelAndHoldAtTime hidden, as in Firefox: they must render the same. */
async function paramWithoutCancelAndHold(seeds: number) {
  const native = Object.getOwnPropertyDescriptor(AudioParam.prototype, "cancelAndHoldAtTime")!;
  let worstSample = 0;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const withIt = await renderSequence(seed, ourParam);
    delete (AudioParam.prototype as { cancelAndHoldAtTime?: unknown }).cancelAndHoldAtTime;
    try {
      const without = await renderSequence(seed, ourParam);
      withIt.samples.forEach((value, index) => { worstSample = Math.max(worstSample, relative(value, without.samples[index]!)); });
    } finally {
      Object.defineProperty(AudioParam.prototype, "cancelAndHoldAtTime", native);
    }
  }
  return { worstSample };
}

Object.assign((window as unknown as { klangwerk: object }).klangwerk, { paramConformance, paramWithoutCancelAndHold });

/* ---- FrequencyEnvelope against Tone.FrequencyEnvelope ---------------------- */

const ENVELOPE = { attack: 0.002, decay: 0.21, sustain: 0.08, release: 0.06, baseFrequency: 60, octaves: 4.4, exponent: 2.35 };
const PLAN: readonly [number, number, number][] = [[0.05, 0.86, 0.12], [0.3, 1, 0.05], [0.33, 0.86, 0.2], [0.8, 1, 0.4]];

async function frequencyEnvelopeConformance() {
  const ours = new OfflineAudioContext(1, 44_100, 44_100);
  const previous = useContext(ours);
  try {
    const envelope = new FrequencyEnvelope(ENVELOPE);
    envelope.octaves = 3.1;
    envelope.baseFrequency = 85;
    envelope.connect(ours.destination);
    for (const [time, velocity, length] of PLAN) {
      envelope.triggerAttack(time, velocity);
      envelope.triggerRelease(time + length);
    }
  } finally {
    swapSound(previous);
  }
  const mine = (await ours.startRendering()).getChannelData(0);
  const theirs = (await Tone.Offline(() => {
    const envelope = new Tone.FrequencyEnvelope(ENVELOPE).toDestination();
    envelope.octaves = 3.1;
    envelope.baseFrequency = 85;
    for (const [time, velocity, length] of PLAN) {
      envelope.triggerAttack(time, velocity);
      envelope.triggerRelease(time + length);
    }
  }, 1, 1, 44_100)).getChannelData(0);
  let worst = 0;
  mine.forEach((value, index) => { worst = Math.max(worst, Math.abs(value - theirs[index]!) / Math.max(1, Math.abs(value))); });
  return { worst, peak: Math.max(...mine) };
}

Object.assign((window as unknown as { klangwerk: object }).klangwerk, { frequencyEnvelopeConformance });

/* ---- note values and pitches against Tone.Time and Tone.Frequency --------- */

/** Values that differ from Tone's in any bit, at a few tempi. */
function noteValueConformance(): string[] {
  const mismatches: string[] = [];
  const previous = useContext(new OfflineAudioContext(1, 128, 44_100));
  try {
    for (const tempo of [120, 128, 145, 150, 155, 172]) {
      setBpm(tempo);
      Tone.getTransport().bpm.value = tempo;
      for (const value of ["1n", "2n", "4n", "8n", "16n", "32n", "8n.", "4n.", "4t", "8t", "16t", 0.25]) {
        const ours = toSeconds(value);
        const theirs = Tone.Time(value).toSeconds();
        if (ours !== theirs) mismatches.push(`${tempo} ${value}: ${ours} vs ${theirs}`);
      }
    }
    for (const note of ["B0", "C1", "C2", "B2", "C3", "D3", "F#1", "Db2", "A4"]) {
      if (toFrequency(note) !== Tone.Frequency(note).toFrequency()) mismatches.push(`${note}: ${toFrequency(note)} vs ${Tone.Frequency(note).toFrequency()}`);
    }
    for (let midi = 21; midi <= 108; midi += 1) {
      if (midiFrequency(midi) !== Tone.Frequency(midi, "midi").toFrequency()) mismatches.push(`midi ${midi}`);
    }
  } finally {
    swapSound(previous);
  }
  return mismatches;
}

Object.assign((window as unknown as { klangwerk: object }).klangwerk, { noteValueConformance });

/* ---- LeanEq3 (bands summed by the next node) against Tone.EQ3 ------------- */

async function eq3Conformance() {
  const options = { low: 4, mid: -3, high: 2.5, lowFrequency: 180, highFrequency: 4_800 };
  const noise = (context: BaseAudioContext) => {
    const buffer = context.createBuffer(2, 44_100, 44_100);
    const next = random(7);
    for (let channel = 0; channel < 2; channel += 1) buffer.getChannelData(channel).forEach((_, index, data) => { data[index] = next() * 2 - 1; });
    return buffer;
  };
  const ours = new OfflineAudioContext(2, 44_100, 44_100);
  const previous = useContext(ours);
  try {
    const source = ours.createBufferSource();
    source.buffer = noise(ours);
    const eq = new LeanEq3(options);
    const after = ours.createGain();
    connect(source, eq);
    eq.connect(after);
    after.connect(ours.destination);
    source.start(0);
  } finally {
    swapSound(previous);
  }
  const mine = await ours.startRendering();
  const theirs = (await Tone.Offline((context) => {
    const source = new Tone.ToneBufferSource(noise(context.rawContext as unknown as BaseAudioContext) as never);
    const eq = new Tone.EQ3(options).toDestination();
    source.connect(eq);
    source.start(0);
  }, 1, 2, 44_100)).get()!;
  let worst = 0;
  let peak = 0;
  for (let channel = 0; channel < 2; channel += 1) {
    const a = mine.getChannelData(channel);
    const b = theirs.getChannelData(channel);
    a.forEach((value, index) => { worst = Math.max(worst, Math.abs(value - b[index]!)); peak = Math.max(peak, Math.abs(value)); });
  }
  return { worst, peak };
}

Object.assign((window as unknown as { klangwerk: object }).klangwerk, { eq3Conformance });
