import { afterEach, describe, expect, it, vi } from "vitest";
import { microphoneSession, playThroughSilentSwitch, resetSilentSwitchForTests, silentWav } from "../src/ios";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

function fakeAudio() {
  const played: string[] = [];
  class FakeAudio {
    loop = false;
    constructor(readonly src: string) {}
    setAttribute(): void {}
    play(): Promise<void> {
      played.push(this.src);
      return Promise.resolve();
    }
  }
  vi.stubGlobal("Audio", FakeAudio);
  return played;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSilentSwitchForTests();
});

describe("sound through the iPhone's silent switch", () => {
  it("declares the page's sound as playback where Safari has an audio session (iOS 17+)", () => {
    const session = { type: "auto" };
    const played = fakeAudio();
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5, audioSession: session });
    playThroughSilentSwitch();
    expect(session.type).toBe("playback");
    expect(played).toEqual([]);
  });

  it("plays a silent element along on older iPhones, once", () => {
    const played = fakeAudio();
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5 });
    playThroughSilentSwitch();
    playThroughSilentSwitch();
    expect(played).toHaveLength(1);
  });

  it("leaves other phones alone", () => {
    const played = fakeAudio();
    vi.stubGlobal("navigator", { userAgent: ANDROID, maxTouchPoints: 5 });
    playThroughSilentSwitch();
    expect(played).toEqual([]);
  });

  it("makes a valid, silent WAV", async () => {
    const bytes = new Uint8Array(await silentWav().arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(bytes.length).toBe(44 + 2_000);
    expect(bytes.slice(44).every((value) => value === 128)).toBe(true);
  });

  it("lets Safari choose while a microphone records, then plays through the switch again", () => {
    const session = { type: "auto" };
    vi.stubGlobal("navigator", { userAgent: IPHONE, maxTouchPoints: 5, audioSession: session });
    microphoneSession(true);
    expect(session.type, "untouched before the sound is on").toBe("auto");
    playThroughSilentSwitch();
    microphoneSession(true);
    expect(session.type).toBe("auto");
    microphoneSession(false);
    expect(session.type).toBe("playback");
  });
});
