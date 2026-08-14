// A minimal counting semaphore that caps how many CLI child processes run at
// once. Each `claude`/`codex` process costs hundreds of MB, so an unbounded
// burst of concurrent Turns can swap the machine — see issue #5. Requests
// past the cap queue (FIFO) rather than failing.

export class AbortedWhileQueuedError extends Error {
  constructor() {
    super("aborted while waiting for a concurrency slot");
    this.name = "AbortedWhileQueuedError";
  }
}

type Waiter = {
  grant: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class Semaphore {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(max: number) {
    this.available = max;
  }

  /**
   * Resolves with a release() function once a slot is free. If `signal`
   * fires while still queued (client disconnected, or a timeout that spans
   * the wait), the wait is abandoned and the promise rejects with
   * AbortedWhileQueuedError — no slot is ever taken for it.
   *
   * release() is safe to call more than once; only the first call has an
   * effect.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.available++;
        this.dequeueNext();
      };

      const grant = () => {
        this.available--;
        resolve(release);
      };

      if (this.available > 0) {
        grant();
        return;
      }

      if (signal?.aborted) {
        reject(new AbortedWhileQueuedError());
        return;
      }

      const waiter: Waiter = { grant };
      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new AbortedWhileQueuedError());
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private dequeueNext(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.grant();
  }
}
