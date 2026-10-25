// The spawn path shared by both Backends: spawn a binary in a given directory
// with a scrubbed environment, read NDJSON off its stdout, drain its stderr.
// Which binary and which flags is the caller's business, not this file's.

import type { DecodedLine, TurnOutcome, TurnRun, Usage } from "./index.ts";

/**
 * Maps the usage object both CLIs report (`input_tokens` / `output_tokens`)
 * onto this server's Usage shape. Undefined when the CLI reported no usage.
 */
export function toUsage(raw: any): Usage | undefined {
  if (!raw) return undefined;
  return {
    promptTokens: raw.input_tokens,
    completionTokens: raw.output_tokens,
    totalTokens: (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
  };
}

/**
 * Only the last of stderr is surfaced to the client, so a runaway or noisy
 * CLI can't blow up the error envelope.
 */
const STDERR_TAIL_CHARS = 4000;

export function stderrTail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? trimmed.slice(-STDERR_TAIL_CHARS) : trimmed;
}

// Variables a parent coding-agent session leaks into its children. Passing them
// on would make a spawned CLI believe it is a nested session, or send its
// Git operations at the parent's repository. Same rule Sphinx applies to its
// own reviewer processes (sphinx/src/evaluator.js, childEnvironment).
const PARENT_SESSION_PATTERNS: RegExp[] = [
  /^CODEX_(?:THREAD|SESSION|TURN|PARENT)(?:_|$)/u,
  /^CLAUDE_(?:SESSION|PARENT)(?:_|$)/u,
  /^PI_(?:SESSION(?:_|$)|PROVIDER$|MODEL$)/u,
  /^SPHINX_(?:CLAUDE|CURSOR|OPENCODE)_SESSION$/u,
  // commandcode's own variables are CMD_* and COMMAND_CODE_*, and many of them
  // are user settings the CLI reads (CMD_LOCAL_ONLY, CMD_ZDR, ...), so only
  // the session and parent markers are matched here.
  /^CMD_(?:SESSION|PARENT)(?:_|$)/u,
  /^COMMAND_CODE_(?:SESSION|PARENT)(?:_|$)/u,
];

/**
 * Every CLAUDE_CODE_* variable is parent-session state (entrypoint, ports,
 * messaging sockets, session ids), so a spawned claude must not inherit them.
 * The one exception is a credential that the subscription login itself needs.
 */
const CLAUDE_CODE_PREFIX = /^CLAUDE_CODE_/u;
const CLAUDE_CODE_KEEP = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Environment for a spawned CLI. `apiKeyVars` are the credentials that would
 * make the CLI bill API usage instead of the signed-in plan; they are removed
 * so the subscription login is what answers. NO_COLOR keeps stdout parseable.
 * Never mutates `parent`.
 */
export function childEnvironment(
  parent: Record<string, string | undefined>,
  apiKeyVars: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (apiKeyVars.includes(key)) continue;
    if (key.startsWith("GIT_") || key === "SPHINX_WAITING_GIT" || key === "CLAUDECODE") continue;
    if (PARENT_SESSION_PATTERNS.some((re) => re.test(key))) continue;
    if (CLAUDE_CODE_PREFIX.test(key) && !CLAUDE_CODE_KEEP.has(key)) continue;
    result[key] = value;
  }
  result.NO_COLOR = "1";
  return result;
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
 * Wraps a Backend's event decoder for stdout consumption: trim, parse, decode,
 * and swallow anything that isn't JSON.
 */
export function jsonLineDecoder(
  decodeEvent: (obj: any) => DecodedLine | null,
): (line: string) => DecodedLine | null {
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return decodeEvent(JSON.parse(trimmed));
    } catch {
      return null;
    }
  };
}

export type SpawnSpec = {
  /** Directory the child runs in. Validated by the caller. */
  cwd: string;
  /**
   * What the child reads on stdin before seeing end-of-input: the prompt. It
   * goes on stdin rather than argv, which has a size limit and reads a leading
   * "-" as a flag.
   */
  stdin: string;
  /** Credentials to strip from the child's environment (plan billing). */
  apiKeyVars: readonly string[];
  /** Runs once the Turn is over, success or failure (e.g. temp-file cleanup). */
  cleanup?: () => void;
};

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
  spec: SpawnSpec,
): TurnRun {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd: spec.cwd,
      env: childEnvironment(Bun.env, spec.apiKeyVars),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    spec.cleanup?.();
    throw err;
  }

  // Write the prompt, then close stdin so the child never waits for more. A
  // child that exits before reading gets EPIPE here; its exit code reports that.
  // Bun types stdin as a FileSink; only write and end are used here.
  const stdinSink = (proc as unknown as { stdin: { write(d: string): unknown; end(): unknown } }).stdin;
  void (async () => {
    try {
      stdinSink.write(spec.stdin);
      await stdinSink.end();
    } catch {
      // The child is already gone; finish() reports how it ended.
    }
  })();

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
      spec.cleanup?.();
      return {
        failure: exitCode === 0 ? undefined : `${bin} exited with code ${exitCode}`,
        detail: stderrTail(stderrText),
      };
    },
  };
}
