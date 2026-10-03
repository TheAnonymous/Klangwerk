/**
 * Renders an OfflineAudioContext while scheduling the music a couple of
 * seconds at a time. Chromium processes every connected node from the start
 * of a render, so notes scheduled all at once make a long render slow down
 * quadratically; suspending every two seconds to schedule the next stretch
 * keeps it linear. Where offline suspend is missing (Firefox), everything is
 * scheduled at once. `onProgress` hears the share rendered so far.
 */
export async function renderInChunks(context: OfflineAudioContext, schedule: (until: number) => void, seconds: number, chunk = 2, onProgress: (share: number) => void = () => undefined): Promise<AudioBuffer> {
  const ahead = chunk * 1.25;
  if (typeof context.suspend !== "function") {
    schedule(seconds);
    return context.startRendering();
  }
  schedule(Math.min(seconds, ahead));
  for (let at = chunk; at < seconds; at += chunk) {
    const until = Math.min(seconds, at + ahead);
    void context.suspend(at).then(() => {
      onProgress(at / seconds);
      schedule(until);
      void context.resume();
    });
  }
  return context.startRendering();
}
