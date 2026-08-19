// The adapter boundary: nothing outside a Backend file (e.g. src/backends/claude.ts)
// may know a specific CLI binary or its flags exist.

import type { ModelConfig } from "../config.ts";
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

export type Backend = {
  bin: string;
  /**
   * Whether this CLI emits incremental token deltas. When false, the answer
   * arrives as one complete message and is streamed to the client as a single
   * SSE chunk. Surfaced verbatim by GET /capabilities so clients know upfront.
   */
  streaming: boolean;
  buildArgs(model: ModelConfig, prompt: string, stream: boolean, reasoningEffort?: string): string[];
  decode(line: string): DecodedLine | null;
};

export const backends: Record<string, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
};
