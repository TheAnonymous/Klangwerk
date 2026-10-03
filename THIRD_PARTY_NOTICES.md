# Third-party notices

`src/param.ts` ports the automation semantics of Tone.js 15.5 (`Param`, `Timeline`; https://github.com/Tonejs/Tone.js), and `src/tone/` rebuilds Tone.js nodes and instruments (Gain, Panner, Delay, Compressor, Limiter, WaveShaper, Noise, FrequencyEnvelope, Filter, EQ3, Chorus, CrossFade, StereoWidener, Vibrato, Oscillator, Envelope, Synth voices) on native nodes; the lean nodes and voices come from Kitty and Track303 (MIT). Tone.js is also a development dependency, used only by the tests that check the port against it.

## Tone.js

MIT License

Copyright (c) 2014-2025 Yotam Mann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
