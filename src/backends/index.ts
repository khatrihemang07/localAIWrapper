// The Backend boundary: nothing outside a Backend file (e.g. src/backends/claude.ts)
// may know a specific CLI binary, its flags, or which environment variables
// that CLI reads.
//
// A Backend is reached by spawning its CLI (see ./cli.ts), and that is the only
// way this server reaches one. See docs/adr/0007-cli-only-transport.md.

import type { ModelConfig } from "../config.ts";
import type { Access, JsonSchemaFormat } from "../requestOptions.ts";
import { claudeBackend } from "./claude.ts";
import { codexBackend } from "./codex.ts";

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type DecodedLine = {
  text?: string;
  usage?: Usage;
  error?: string;
  /**
   * True on the line that ends a Turn (success or failure). The streaming
   * path uses this — never the mere presence of `usage` — to stop reading:
   * a terminal line happens to also carry the full final answer in `text`,
   * and relying on `usage` being present to detect "stop" would let a
   * terminal line without usage fall through and get re-emitted as a
   * duplicate content chunk (the whole answer, twice).
   */
  final?: boolean;
};

export type TurnRequest = {
  /** The Model with the request's system message (if any) folded in. */
  model: ModelConfig;
  prompt: string;
  stream: boolean;
  reasoningEffort?: string;
  web: boolean;
  access: Access;
  /** Absolute, already validated realpath of the directory the Turn runs in. */
  workdir: string;
  responseFormat?: JsonSchemaFormat;
};

/**
 * The CLI's own verdict on a Turn, distinct from a `DecodedLine.error` — which
 * is the agent itself reporting a problem through a well-formed event.
 */
export type TurnOutcome = {
  /**
   * Short cause of a failure, e.g. `claude exited with code 1`.
   * Undefined when the process completed cleanly, whatever the agent said.
   */
  failure?: string;
  /** Stderr tail, populated regardless of outcome, for diagnostics. */
  detail: string;
};

/**
 * One in-flight Turn. `events` is consumed until the caller sees a terminal
 * DecodedLine (streaming breaks early) or the iterable ends (non-streaming
 * reads to EOF); `finish()` is then awaited for the process's own verdict.
 * `finish()` must stay callable — and must resolve — after an early break.
 */
export type TurnRun = {
  events: AsyncIterable<DecodedLine>;
  kill(): void;
  finish(): Promise<TurnOutcome>;
};

export type Backend = {
  /** Identifies the Backend in logs and error envelopes, e.g. `claude`. */
  label: string;
  /**
   * Whether this Backend emits incremental token deltas. When false, the
   * answer arrives as one complete message and is streamed to the client as a
   * single SSE chunk. Surfaced verbatim by GET /v1/models so clients know
   * upfront.
   */
  streaming: boolean;
  run(req: TurnRequest, signal: AbortSignal): TurnRun;
};

const BACKENDS: Record<string, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
};

export function getBackend(name: string): Backend | undefined {
  return Object.hasOwn(BACKENDS, name) ? BACKENDS[name] : undefined;
}
