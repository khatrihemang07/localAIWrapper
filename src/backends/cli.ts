// The cli Transport: spawn a binary, read NDJSON off its stdout, drain its
// stderr. Shared by both CLI Backends — which binary and which flags is the
// caller's business, not this file's.
//
// This code used to live inline in src/server.ts. It moved here when Backends
// grew a `run()` of their own, so that the sdk Transport (no argv, no stderr,
// no exit code) could be a peer rather than a special case branched on at four
// separate points of the request lifecycle.

import type { DecodedLine, TurnOutcome, TurnRun } from "./index.ts";

/**
 * Only the last of stderr is surfaced to the client, so a runaway or noisy
 * CLI can't blow up the error envelope.
 */
const STDERR_TAIL_CHARS = 4000;

export function stderrTail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? trimmed.slice(-STDERR_TAIL_CHARS) : trimmed;
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Spawns `bin` and turns its stdout into DecodedLines. Throws synchronously if
 * the binary can't be started (e.g. not on PATH) — the caller is still
 * pre-headers at that point and can return a proper error envelope even for a
 * streaming request.
 */
export function runCli(
  bin: string,
  args: string[],
  decode: (line: string) => DecodedLine | null,
  signal: AbortSignal,
): TurnRun {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });

  // Covers the race between the caller acquiring its slot and us spawning.
  if (signal.aborted) proc.kill();
  const killOnAbort = () => proc.kill();
  signal.addEventListener("abort", killOnAbort);

  // Drain stderr concurrently so the pipe never backs up; keep the tail in
  // case the process exits without a decodable error line.
  let stderrText = "";
  const stderrDrain = (async () => {
    for await (const chunk of readLines(proc.stderr)) {
      stderrText += chunk + "\n";
    }
  })();

  async function* events(): AsyncGenerator<DecodedLine> {
    for await (const line of readLines(proc.stdout)) {
      const decoded = decode(line);
      if (decoded) yield decoded;
    }
  }

  return {
    events: events(),
    kill: () => proc.kill(),
    async finish(): Promise<TurnOutcome> {
      const exitCode = await proc.exited;
      await stderrDrain;
      signal.removeEventListener("abort", killOnAbort);
      return {
        failure: exitCode === 0 ? undefined : `${bin} exited with code ${exitCode}`,
        detail: stderrTail(stderrText),
      };
    },
  };
}
