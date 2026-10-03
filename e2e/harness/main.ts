import {
  Clock, createBus, createChorus, createPingPong, createReverb, clap, crash, driveCurve, duck, fmBell, hallImpulse, kick, Kit, Master, MasterRecorder, midiToHz,
  noiseHit, pulseWave, renderInChunks, snare, Transport, voice,
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
