/*
 * iPhones mute web audio while the ring/silent switch is set to silent, even
 * at full volume: Safari treats it like a system sound. Declaring the page's
 * sound as playback (iOS 17 and later) lets it play like a music app. Older
 * iPhones get the same by a silent media element playing along. Call it when
 * the audio is unlocked, inside the tap that switches the sound on, and only
 * for the live sound (not for offline renders).
 *
 * While a microphone is open, the session goes back to "auto": Safari then
 * records and plays as it always did (play-and-record, which the silent
 * switch does not mute), and returns to playback when the mic closes.
 */

interface AudioSessionLike {
  type: string;
}

let armed = false;
/** Whether this page declared playback itself (and may switch it for the microphone). */
let declared = false;

function audioSession(): AudioSessionLike | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
}

export function playThroughSilentSwitch(): void {
  if (armed || typeof navigator === "undefined") return;
  armed = true;
  const session = audioSession();
  if (session) {
    try {
      session.type = "playback";
      declared = true;
    } catch {
      // The browser did not allow it here; the sound still plays with the switch on ring.
    }
    return;
  }
  if (!isAppleTouchDevice() || typeof Audio === "undefined") return;
  const element = new Audio(URL.createObjectURL(silentWav()));
  element.loop = true;
  element.setAttribute("playsinline", "");
  void element.play().catch(() => {
    // Not in a tap after all: try again with the next one.
    armed = false;
  });
}

/** The microphone opens (`true`) or closes: record the way Safari chooses, then play through the switch again. */
export function microphoneSession(open: boolean): void {
  const session = audioSession();
  if (!session || !declared) return;
  try {
    session.type = open ? "auto" : "playback";
  } catch {
    // Left as it was; recording and playback still work.
  }
}

function isAppleTouchDevice(): boolean {
  const agent = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
}

/** A quarter of a second of silence as a tiny WAV (8 kHz, 8 bit, mono). */
export function silentWav(): Blob {
  const samples = 2_000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 8_000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return new Blob([bytes], { type: "audio/wav" });
}

/** For tests: forget that the switch was already handled. */
export function resetSilentSwitchForTests(): void {
  armed = false;
  declared = false;
}
