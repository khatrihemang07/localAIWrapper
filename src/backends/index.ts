// The adapter boundary: nothing outside a Backend file (e.g. src/backends/claude.ts)
// may know a specific CLI binary, its flags, or a vendor SDK exists.
//
// A Backend pairs one coding agent with one Transport — the way we reach it.
// There are two Transports per agent:
//
//   sdk  the vendor's own library (@anthropic-ai/claude-agent-sdk,
//        @openai/codex-sdk), which spawns its own bundled binary and hands
//        back typed events. Preferred.
//   cli  spawning the `claude`/`codex` binary off PATH and parsing NDJSON
//        from stdout. The fallback, and still the only Transport if the SDK
//        package isn't installed.
//
// Both Transports of one agent share a decoder, because the SDK's event
// objects and the CLI's stdout lines carry identical field names — the SDKs
// are wrappers around the same binaries (verified live; see docs/adr/0006).

import type { ModelConfig } from "../config.ts";
import { claudeCliBackend, claudeSdkBackend, validateClaudeSdkArgs } from "./claude.ts";
import { codexCliBackend, codexSdkBackend, validateCodexSdkArgs } from "./codex.ts";

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
  model: ModelConfig;
  prompt: string;
  stream: boolean;
  reasoningEffort?: string;
};

/**
 * The transport's own verdict on a Turn, distinct from a `DecodedLine.error`
 * — which is the agent itself reporting a problem through a well-formed event.
 */
export type TurnOutcome = {
  /**
   * Short cause of a transport-level failure, e.g. `claude exited with code 1`.
   * Undefined when the transport completed cleanly, whatever the agent said.
   */
  failure?: string;
  /**
   * Diagnostic context — a stderr tail for the cli Transport, empty for the
   * sdk Transport, which has no stderr of its own. Populated regardless of
   * whether the Turn failed, so it can be appended to an agent-reported error
   * on a process that nonetheless exited zero.
   */
  detail: string;
};

/**
 * One in-flight Turn. `events` is consumed until the caller sees a terminal
 * DecodedLine (streaming breaks early) or the iterable ends (non-streaming
 * reads to EOF); `finish()` is then awaited for the transport's own verdict.
 * `finish()` must stay callable — and must resolve — after an early break.
 */
export type TurnRun = {
  events: AsyncIterable<DecodedLine>;
  kill(): void;
  finish(): Promise<TurnOutcome>;
};

export type Backend = {
  /** Identifies the Backend in logs and error envelopes, e.g. `claude (sdk)`. */
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

export type Transport = "sdk" | "cli";

export const TRANSPORTS: readonly Transport[] = ["sdk", "cli"];

export function isTransport(value: unknown): value is Transport {
  return value === "sdk" || value === "cli";
}

type BackendFamily = {
  cli: Backend;
  /** null when the vendor SDK package could not be imported. */
  sdk: Backend | null;
  /**
   * Throws if a Model's raw `args` cannot be expressed as SDK options. Run at
   * startup for every Model that resolves to the sdk Transport, so an
   * untranslatable flag is a boot failure rather than a silently weaker Turn.
   */
  validateSdkArgs(model: ModelConfig): void;
};

const families: Record<string, BackendFamily> = {
  claude: { cli: claudeCliBackend, sdk: claudeSdkBackend, validateSdkArgs: validateClaudeSdkArgs },
  codex: { cli: codexCliBackend, sdk: codexSdkBackend, validateSdkArgs: validateCodexSdkArgs },
};

export type Resolved = {
  backend: Backend;
  transport: Transport;
  /** Set when the Model asked for sdk but the SDK package wasn't importable. */
  fellBack: boolean;
};

export function backendExists(name: string): boolean {
  return Object.hasOwn(families, name);
}

/**
 * Picks the Transport for a Model. Preference order is sdk, then cli.
 *
 * The *only* automatic fallback is an SDK package that won't import. A
 * runtime error from a working SDK — a 429, a context-length overflow, a
 * refusal — is not "the SDK is broken", and re-running it through the CLI
 * would double the spend on exactly the turns that were already expensive.
 * It is also impossible mid-stream: once the first chunk is flushed the
 * response headers are committed and there is nowhere to fall back to.
 * A Model can pin itself with `"transport": "cli"` in models.json.
 */
export function resolveBackend(name: string, requested?: Transport): Resolved | undefined {
  const family = families[name];
  if (!family) return undefined;

  if (requested === "cli") {
    return { backend: family.cli, transport: "cli", fellBack: false };
  }
  if (family.sdk) {
    return { backend: family.sdk, transport: "sdk", fellBack: false };
  }
  return { backend: family.cli, transport: "cli", fellBack: requested === "sdk" };
}

/** Throws if `model`'s raw `args` can't be translated for the sdk Transport. */
export function validateSdkArgs(name: string, model: ModelConfig): void {
  families[name]?.validateSdkArgs(model);
}
