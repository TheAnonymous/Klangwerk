# Klangwerk

A small music engine on plain Web Audio, with no dependencies, written for
the apps of the [Musik-Werkstatt](https://musik.jodie-oesterling.de/). Every
sound is synthesized: each note builds a small graph of native nodes, plays
it and frees it.

- **Voices** (`voices.ts`): kick, snare, clap, crash, struck tones and noise,
  a subtractive voice (oscillators → filter → amp, with vibrato, glide and
  filter envelopes), two-operator FM bell and electric piano, a riser. They
  take finished numbers (peaks, frequencies, seconds), so every app keeps its
  own sound in how it computes them.
- **Kit** (`kit.ts`): the building blocks: nodes in one call, struck and held
  envelopes, start/stop bookkeeping, vibrato, seeded noise.
- **Mixer** (`mixer.ts`, `effects.ts`): channel buses with drive, sidechain
  pump and sends; reverb, echo, ping-pong and chorus; a master that never
  clips (the app's inserts, gate, compressor, limiter, volume, soft ceiling).
- **Time** (`transport.ts`, `cues.ts`): an audio context made inside the
  first tap, a transport that schedules steps ahead on the audio clock from a
  worker's heartbeat (with swing), skips stalls in whole bars and renders
  offline, and cues that run screen updates when the sound is heard.
- **Param** (`param.ts`): an AudioParam that remembers its automation, so
  ramps can start where the value is (`rampTo`, `cancelAndHoldAtTime`),
  ported from Tone.js and checked against it.
- **Tone layer** (`klangwerk/tone`): for apps whose sound was made with
  Tone.js, the pieces they used (Gain, Panner, Delay, Compressor, Limiter,
  WaveShaper, Noise, FrequencyEnvelope, filters with rolloff, EQ3, chorus,
  cross-fade, widener, vibrato, Tone's oscillators, envelopes and synth
  voices) on native nodes, with Tone's numbers, automation and "now", and a
  current context as Tone's global one. Checked against Tone.js.
- **Plumbing**: sound through the iPhone's ring/silent switch (`ios.ts`),
  chunked offline renders (`offline.ts`), WAV files (`wav.ts`) and a lossless
  live recorder on an AudioWorklet (`recorder.ts`).

The worker clock and the recorder's worklet are made from Blobs, so the engine
needs no bundler support; the page's CSP has to allow `worker-src blob:` and
`script-src blob:`.

## Use

Klangwerk ships as TypeScript source. Add it by commit:

```json
"dependencies": { "klangwerk": "github:TheAnonymous/Klangwerk#<commit>" }
```

```ts
import { createBus, kick, Kit, Master, Transport } from "klangwerk";

const context = new AudioContext();
const kit = new Kit(context);
const master = new Master(context);
const drums = createBus(context, { level: 0.8, to: master.input });
master.open(context.currentTime);
const transport = new Transport({
  stepDuration: () => 15 / 120,
  step: (step, time) => {
    if (step % 4 === 0) kick(kit, drums.input, time, { top: 160, bottom: 50, decay: 0.32, level: 0.9, knock: { level: 0.14 }, click: { level: 0.25 } });
  },
});
transport.begin(context, context.currentTime + 0.05);
```

Vitest runs dependencies through Node, which does not strip types under
`node_modules`; apps whose unit tests import the engine add
`test: { server: { deps: { inline: ["klangwerk"] } } }` to their Vitest config.

## Develop

```sh
npm install
npm run verify   # lint, types, unit tests, browser tests (Chromium, production CSP)
```

All checks run locally; see [AGENTS.md](AGENTS.md).

## License

MIT. `param.ts` and `src/tone/` are ported from Tone.js (MIT), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
