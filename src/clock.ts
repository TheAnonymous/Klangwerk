/*
 * A steady heartbeat for the scheduler, about every 25 ms. Timers in a worker
 * keep running while the page's own timers are throttled (a hidden tab), so
 * the music does not stumble. The worker is made from a Blob, so the engine
 * needs no bundler support; that takes `worker-src blob:` in the page's CSP.
 * Where workers are missing or blocked, a page timer stands in.
 */

const TICKER = `let timer = null;
self.onmessage = (event) => {
  if (timer !== null) clearInterval(timer);
  timer = event.data === "start" ? setInterval(() => self.postMessage(0), 25) : null;
};`;

let tickerUrl: string | null = null;
let workersFail = false;

export class Clock {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly tick: () => void) {}

  start(): void {
    this.stop();
    this.running = true;
    if (workersFail || typeof Worker === "undefined") {
      this.useTimer();
      return;
    }
    try {
      tickerUrl ??= URL.createObjectURL(new Blob([TICKER], { type: "text/javascript" }));
      if (!this.worker) {
        this.worker = new Worker(tickerUrl);
        // A CSP without `worker-src blob:` refuses the worker after it was created.
        this.worker.onerror = (event) => {
          event.preventDefault();
          workersFail = true;
          this.worker?.terminate();
          this.worker = null;
          if (this.running) this.useTimer();
        };
      }
      this.worker.onmessage = () => this.tick();
      this.worker.postMessage("start");
    } catch {
      workersFail = true;
      this.worker = null;
      this.useTimer();
    }
  }

  stop(): void {
    this.running = false;
    this.worker?.postMessage("stop");
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
  }

  private useTimer(): void {
    if (this.timer === null) this.timer = setInterval(() => this.tick(), 25);
  }
}
