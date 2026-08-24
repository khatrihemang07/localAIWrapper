// The only file in this project that knows the `claude` binary exists, what
// flags it takes, or that @anthropic-ai/claude-agent-sdk exists.
//
// Two Transports, one decoder. The SDK spawns its own bundled `claude` binary
// and yields the same event objects the CLI prints as NDJSON — verified live:
// `stream_event`/`content_block_delta` for text, and a terminal `result`
// carrying `subtype`, `is_error`, `terminal_reason`, `result` and `usage`
// under identical field names. So decodeEvent() below serves both, and the
// two Transports can't silently drift in how they read an answer.
//
// Verified CLI behaviour (measured by live probing, see issue #1):
// - `--output-format stream-json` requires `--verbose` when used with `-p`.
// - `--include-partial-messages` is required to get incremental
//   `content_block_delta` events; without it stdout only carries the whole
//   assistant message at once.
// - Text deltas arrive as:
//     {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"…"}}}
// - The final line is:
//     {"type":"result","subtype":"success","result":"…","usage":{…}}
//
// Verified SDK behaviour (measured live, see docs/adr/0006):
// - Authenticates against an existing claude.ai OAuth login with no API key;
//   the `system`/`init` message reports `apiKeySource: "none"` when it does.
// - `settingSources: []`, `allowedTools: []` and `mcpServers: {}` reproduce
//   the ADR-0002 harness strip, measuring ~12.6k prompt tokens against the
//   CLI strip's ~13.8k.
// - The partial stream interleaves `thinking_delta` events, whose payload is
//   `delta.thinking` rather than `delta.text`. decodeEvent() ignores them
//   because it reads `delta.text` — deliberately, not incidentally.

import type { ModelConfig } from "../config.ts";
import type { Backend, DecodedLine, TurnRequest, TurnRun, Usage } from "./index.ts";
import { runCli } from "./cli.ts";
import { pairArgs, runSdkTurn } from "./sdk.ts";

const BIN = "claude";

// ---- shared decoding -------------------------------------------------------

function decodeEvent(obj: any): DecodedLine | null {
  if (obj?.type === "stream_event" && obj.event?.type === "content_block_delta") {
    // `delta.text` is present on text_delta only. thinking_delta carries
    // `delta.thinking` instead and is intentionally dropped here: reasoning is
    // not part of the assistant's answer on this server's wire protocol.
    const text = obj.event.delta?.text;
    return typeof text === "string" ? { text } : null;
  }

  if (obj?.type === "result") {
    const usage: Usage | undefined = obj.usage
      ? {
          promptTokens: obj.usage.input_tokens,
          completionTokens: obj.usage.output_tokens,
          totalTokens: (obj.usage.input_tokens ?? 0) + (obj.usage.output_tokens ?? 0),
        }
      : undefined;

    // `is_error` and `terminal_reason` are the reliable failure signals:
    // `subtype` has been observed to still read "success" on API-level
    // failures, so it can't be trusted alone. Verified payload from a failed
    // auth call:
    //   {"is_error":true, ..., "terminal_reason":"api_error",
    //    "subtype":"success", "result":"Not logged in · Please run /login"}
    // Trusting `subtype` there would relay the login error to the client as
    // the model's own answer — a silent, plausible-looking wrong result.
    // `is_error` alone has been sufficient on every payload observed so far
    // ("completed" is the terminal_reason on success). `terminal_reason` is
    // checked as a second signal, but only against reasons known to mean
    // failure — treating every unrecognised value as an error would turn a
    // future success state into a spurious 502.
    const failedTerminally = obj.terminal_reason === "api_error";
    if (obj.subtype === "success" && obj.is_error !== true && !failedTerminally) {
      return {
        text: typeof obj.result === "string" ? obj.result : undefined,
        usage,
        final: true,
      };
    }

    return {
      error: typeof obj.result === "string" ? obj.result : "claude reported an error",
      usage,
      final: true,
    };
  }

  return null;
}

function decodeLine(line: string): DecodedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return decodeEvent(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

// ---- cli Transport ---------------------------------------------------------

function buildArgs(model: ModelConfig, prompt: string, stream: boolean, reasoningEffort?: string): string[] {
  // The prompt must be given as the leading positional argument. Several of
  // claude's flags (e.g. --allowed-tools, --mcp-config) are variadic and
  // greedily swallow whatever comes right after them; a prompt placed after
  // those flags gets absorbed as one of their values instead of being read
  // as the prompt, and the CLI then errors with "Input must be provided
  // either through stdin or as a prompt argument". Putting the prompt first
  // avoids that entirely.
  const args: string[] = [prompt, "-p", "--model", model.model];

  if (model.systemPrompt) {
    args.push("--system-prompt", model.systemPrompt);
  }

  // Per-request override from the chat-completions body (see
  // docs/adr/0005-reasoning-effort-per-request.md); claude's own accepted
  // values (low/medium/high/xhigh/max) are not validated here.
  if (reasoningEffort) {
    args.push("--effort", reasoningEffort);
  }

  // stream-json is used for both streaming and non-streaming turns so a
  // single decoder can serve both: in the non-streaming case we simply never
  // request partial messages, so the only line carrying text is the final
  // "result" line.
  args.push("--output-format", "stream-json", "--verbose");
  if (stream) {
    args.push("--include-partial-messages");
  }

  // The Model's raw, verbatim escape-hatch args (harness-stripping flags,
  // etc.) — always appended, never interpreted here.
  args.push(...model.args);

  return args;
}

export const claudeCliBackend: Backend = {
  label: "claude (cli)",
  streaming: true,
  run(req: TurnRequest, signal: AbortSignal): TurnRun {
    const args = buildArgs(req.model, req.prompt, req.stream, req.reasoningEffort);
    return runCli(BIN, args, decodeLine, signal);
  },
};

// ---- sdk Transport ---------------------------------------------------------

type SdkOptions = Record<string, unknown>;

/**
 * models.json carries raw CLI flags, which the sdk Transport has no argv to
 * append them to. Each is translated to its typed SDK option instead.
 *
 * Anything not in this table is a hard error rather than a silent drop:
 * quietly ignoring `--allowed-tools ""` would re-enable roughly thirty tool
 * schemas and blow the ADR-0002 token budget with no error raised anywhere —
 * a Turn that still looks like it worked, but costs more and is no longer
 * sandboxed. A boot failure is strictly the milder outcome.
 */
const CLAUDE_FLAG_TRANSLATIONS: Record<
  string,
  { takesValue: boolean; apply(options: SdkOptions, value: string | undefined): void }
> = {
  // Setting mcpServers explicitly is already the strict behaviour this flag
  // asks the CLI for, so it needs no separate option.
  "--strict-mcp-config": { takesValue: false, apply: () => {} },
  "--mcp-config": {
    takesValue: true,
    apply(options, value) {
      const parsed = JSON.parse(value ?? "{}");
      options.mcpServers = parsed?.mcpServers ?? {};
    },
  },
  "--setting-sources": {
    takesValue: true,
    apply(options, value) {
      // `[]` is the SDK's documented isolation mode — the exact equivalent of
      // passing an empty --setting-sources to the CLI.
      options.settingSources = value ? value.split(",").filter(Boolean) : [];
    },
  },
  // Slash commands are loaded from the filesystem settings sources, so an
  // empty settingSources already means none are available.
  "--disable-slash-commands": { takesValue: false, apply: () => {} },
  "--allowed-tools": {
    takesValue: true,
    apply(options, value) {
      options.allowedTools = value ? value.split(",").filter(Boolean) : [];
    },
  },
  "--disallowed-tools": {
    takesValue: true,
    apply(options, value) {
      options.disallowedTools = value ? value.split(",").filter(Boolean) : [];
    },
  },
};

function translateArgs(model: ModelConfig): SdkOptions {
  const options: SdkOptions = {};
  const pairs = pairArgs(model.args, (flag) => CLAUDE_FLAG_TRANSLATIONS[flag]?.takesValue === true);

  for (const { flag, value } of pairs) {
    const translation = CLAUDE_FLAG_TRANSLATIONS[flag];
    if (!translation) {
      throw new Error(
        `claude Backend: cannot express "${flag}" as an SDK option. ` +
          `Add a translation in src/backends/claude.ts, or pin this Model with "transport": "cli" in models.json. ` +
          `Known flags: ${Object.keys(CLAUDE_FLAG_TRANSLATIONS).join(", ")}`,
      );
    }
    if (translation.takesValue && value === undefined) {
      throw new Error(`claude Backend: "${flag}" in models.json is missing its value`);
    }
    translation.apply(options, value);
  }

  return options;
}

export function validateClaudeSdkArgs(model: ModelConfig): void {
  translateArgs(model);
}

// Import once at startup. A package that won't load is the *only* condition
// that falls back to the cli Transport (see resolveBackend in ./index.ts).
let sdk: { query: (args: any) => AsyncIterable<any> } | null = null;
try {
  sdk = (await import("@anthropic-ai/claude-agent-sdk")) as any;
} catch {
  sdk = null;
}

export const claudeSdkBackend: Backend | null = sdk
  ? {
      label: "claude (sdk)",
      streaming: true,
      run(req: TurnRequest, signal: AbortSignal): TurnRun {
        const options: SdkOptions = {
          model: req.model.model,
          ...translateArgs(req.model),
          includePartialMessages: req.stream,
        };
        if (req.model.systemPrompt) options.systemPrompt = req.model.systemPrompt;
        if (req.reasoningEffort) options.effort = req.reasoningEffort;

        return runSdkTurn(
          BIN,
          async function* (abortSignal) {
            const abortController = new AbortController();
            abortSignal.addEventListener("abort", () => abortController.abort());
            if (abortSignal.aborted) abortController.abort();

            for await (const message of sdk!.query({
              prompt: req.prompt,
              options: { ...options, abortController },
            })) {
              const decoded = decodeEvent(message);
              if (decoded) yield decoded;
            }
          },
          signal,
        );
      },
    }
  : null;
