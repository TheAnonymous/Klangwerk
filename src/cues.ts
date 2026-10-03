/*
 * Things to show when they are heard: callbacks for a time on the audio
 * clock, run on the animation frame closest to it (a little early rather than
 * late, and dropped once they are a quarter of a second stale, as Tone.Draw).
 */

const ANTICIPATION = 0.008;
const EXPIRATION = 0.25;

export class Cues {
  private queue: { time: number; callback: () => void }[] = [];
  private frame = -1;

  constructor(private readonly clock: () => number) {}

  /** Runs `callback` when the audio clock reaches `time`. */
  at(time: number, callback: () => void): void {
    let index = this.queue.length;
    while (index > 0 && this.queue[index - 1]!.time > time) index -= 1;
    this.queue.splice(index, 0, { time, callback });
    if (this.frame === -1) this.frame = requestAnimationFrame(() => this.run());
  }

  cancel(): void {
    this.queue = [];
    if (this.frame !== -1) cancelAnimationFrame(this.frame);
    this.frame = -1;
  }

  private run(): void {
    this.frame = -1;
    const now = this.clock();
    while (this.queue.length > 0 && this.queue[0]!.time <= now + ANTICIPATION) {
      const cue = this.queue.shift()!;
      if (now - cue.time <= EXPIRATION) cue.callback();
    }
    if (this.queue.length > 0) this.frame = requestAnimationFrame(() => this.run());
  }
}
