// The sdk Transport's shared plumbing. Shared by both SDK Backends — which
// vendor library and which options is the caller's business, not this file's.
//
// An SDK Turn has no argv, no stderr and no exit code, so `runSdkTurn` fills
// the same TurnRun contract from a plain async iterable: it drains the vendor
// iterable in the background into a queue, which decouples two things the
// server does that a bare `for await` cannot support together —
//
//   1. breaking out early on a terminal DecodedLine (the streaming path), and
//   2. still awaiting the transport's own verdict afterwards via finish().
//
// Draining in the background means an early break can't strand the vendor
// iterable mid-flight, and finish() always resolves.

import type { DecodedLine, TurnOutcome, TurnRun } from "./index.ts";

export type SdkTurnSource = (signal: AbortSignal) => AsyncIterable<DecodedLine>;

export function runSdkTurn(label: string, start: SdkTurnSource, signal: AbortSignal): TurnRun {
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  const forwardAbort = () => abort.abort();
  signal.addEventListener("abort", forwardAbort);

  const queue: DecodedLine[] = [];
  let ended = false;
  let failure: string | undefined;
  let wake: (() => void) | undefined;

  let markDone!: () => void;
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });

  void (async () => {
    try {
      for await (const line of start(abort.signal)) {
        queue.push(line);
        wake?.();
        wake = undefined;
      }
    } catch (err) {
      // A throw *because we aborted* is the expected shape of a cancelled
      // Turn, not a backend failure — the server already knows why it aborted
      // and has its own message for it.
      if (!abort.signal.aborted) {
        failure = `${label} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      ended = true;
      wake?.();
      wake = undefined;
      signal.removeEventListener("abort", forwardAbort);
      markDone();
    }
  })();

  async function* events(): AsyncGenerator<DecodedLine> {
    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    events: events(),
    kill: () => abort.abort(),
    async finish(): Promise<TurnOutcome> {
      await done;
      // The sdk Transport has no stderr of its own; the vendor library's
      // message is already folded into `failure`.
      return { failure, detail: "" };
    },
  };
}

/**
 * Splits a Model's raw `args` array into flag/value pairs so each can be
 * translated to a typed SDK option. `takesValue` decides whether a flag
 * consumes the next element (`--allowed-tools ""`) or stands alone
 * (`--strict-mcp-config`).
 */
export function pairArgs(
  args: string[],
  takesValue: (flag: string) => boolean,
): Array<{ flag: string; value?: string }> {
  const pairs: Array<{ flag: string; value?: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (takesValue(flag)) {
      pairs.push({ flag, value: args[i + 1] });
      i++;
    } else {
      pairs.push({ flag });
    }
  }
  return pairs;
}
