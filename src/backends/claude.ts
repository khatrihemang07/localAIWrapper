// The only file in this project that knows the `claude` binary exists, what
// flags it takes, or which environment variables it reads for billing.
//
// Verified CLI behaviour (live probing, see issue #1 and docs/adr/0007):
// - `--output-format stream-json` requires `--verbose` when used with `-p`.
// - `--include-partial-messages` is required to get incremental
//   `content_block_delta` events; without it stdout only carries the whole
//   assistant message at once.
// - Text deltas arrive as:
//     {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"…"}}}
// - The final line is:
//     {"type":"result","subtype":"success","result":"…","usage":{…}}
//   With `--json-schema`, `result` carries the schema-conforming JSON as text
//   and `structured_output` carries the same answer as an object; the decoder
//   prefers `structured_output` (fixture: test/fixtures/claude-structured-final-line.jsonl).
// - A new assistant message starts with a `message_start` stream event; after a
//   tool_use block its text is separated from the text before the tool call
//   (see createClaudeLineDecoder).
// - The prompt is read from stdin (`-p` with no positional argument).
// - `--tools ""` removes the built-in tool definitions from the prompt
//   entirely (measured: 23 definitions / ~9.4k prompt tokens without it,
//   0 / ~0.6k with it). `--allowed-tools ""` only blocks tool use; the
//   definitions still count. See docs/adr/0007.
// - The Sphinx-style harness flags `--safe-mode`, `--no-session-persistence`
//   and `--no-chrome` do not disturb subscription login (apiKeySource "none").

import type { Backend, DecodedLine, TurnRequest, TurnRun } from "./index.ts";
import { jsonLineDecoder, runCli, toUsage } from "./cli.ts";

const BIN = "claude";

/** Credentials that would make `claude` bill API usage instead of the plan. */
const API_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// ---- decoding --------------------------------------------------------------

/**
 * What the decoder remembers across one Turn's lines. A Turn with tools is
 * several assistant messages: text before a tool call and text after it arrive
 * as separate messages, and would otherwise run together.
 */
type StreamState = {
  /** A tool_use block has started since the last message_start. */
  toolUsed: boolean;
  /** Some text has already been streamed in this Turn. */
  emittedText: boolean;
  /** The next text delta opens a new message after a tool call: prefix it. */
  separatorDue: boolean;
};

function decodeEvent(obj: any, state: StreamState): DecodedLine | null {
  if (obj?.type === "stream_event") {
    const event = obj.event;
    if (event?.type === "message_start") {
      if (state.toolUsed && state.emittedText) state.separatorDue = true;
      state.toolUsed = false;
      return null;
    }
    if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
      state.toolUsed = true;
      return null;
    }
    if (event?.type === "content_block_delta") {
      // `delta.text` is present on text_delta only. thinking_delta carries
      // `delta.thinking` instead and is intentionally dropped here: reasoning is
      // not part of the assistant's answer on this server's wire protocol.
      const text = event.delta?.text;
      if (typeof text !== "string") return null;
      let out = text;
      if (state.separatorDue) {
        out = `\n\n${text}`;
        state.separatorDue = false;
      }
      state.emittedText = true;
      return { text: out };
    }
    return null;
  }

  if (obj?.type === "result") {
    const usage = toUsage(obj.usage);

    // `is_error` and `terminal_reason` are the reliable failure signals:
    // `subtype` has been observed to still read "success" on API-level
    // failures, so it can't be trusted alone. Verified payload from a failed
    // auth call:
    //   {"is_error":true, ..., "terminal_reason":"api_error",
    //    "subtype":"success", "result":"Not logged in · Please run /login"}
    // Trusting `subtype` there would relay the login error to the client as
    // the model's own answer — a silent, plausible-looking wrong result.
    const failedTerminally = obj.terminal_reason === "api_error";
    if (obj.subtype === "success" && obj.is_error !== true && !failedTerminally) {
      // With --json-schema the schema-conforming answer is in structured_output
      // (an object); `result` carries the same JSON as text. Prefer the object.
      const structured = obj.structured_output;
      const text =
        structured !== undefined && structured !== null
          ? JSON.stringify(structured)
          : typeof obj.result === "string"
            ? obj.result
            : undefined;
      return { text, usage, final: true };
    }

    return {
      error: typeof obj.result === "string" ? obj.result : "claude reported an error",
      usage,
      final: true,
    };
  }

  return null;
}

/** A line decoder for one Turn: its stream state is not shared across Turns. */
export function createClaudeLineDecoder(): (line: string) => DecodedLine | null {
  const state: StreamState = { toolUsed: false, emittedText: false, separatorDue: false };
  return jsonLineDecoder((obj) => decodeEvent(obj, state));
}

// ---- invocation ------------------------------------------------------------

/**
 * The tool set a Turn gets, as `--tools` names. `none` (the default) offers no
 * file tools; an empty list means no built-in tools at all, which is the plain
 * chat case. Each name's definition costs prompt tokens, so nothing is offered
 * that the request did not ask for.
 *
 * These tools are NOT a sandbox: Read/Edit/Write accept absolute paths, so
 * read-only and workspace-write do not confine the Turn to its workdir. See
 * docs/adr/0007.
 */
export function toolsFor(access: TurnRequest["access"], web: boolean): string[] {
  const tools: string[] = [];
  if (access === "read-only" || access === "workspace-write") tools.push("Read", "Glob", "Grep");
  if (access === "workspace-write") tools.push("Edit", "Write");
  if (web) tools.push("WebSearch", "WebFetch");
  return tools;
}

/**
 * The argv for one Turn. The prompt is not here: it goes on stdin (`-p` reads
 * it there when no positional is given). Value-taking flags whose value is
 * free text use the `--flag=value` form, so a value starting with "-" is never
 * read as a flag.
 */
export function buildClaudeArgs(req: TurnRequest, schemaJson?: string): string[] {
  const args: string[] = ["-p", "--model", req.model.model];

  // The harness strip (docs/adr/0002, superseded by 0007): no CLAUDE.md, no
  // hooks, no MCP servers, no session file, no browser integration, and only
  // the tools this request is allowed.
  const tools = toolsFor(req.access, req.web);
  args.push("--safe-mode", "--no-session-persistence", "--no-chrome");
  args.push("--tools", tools.join(","));
  args.push("--allowed-tools", tools.join(","));

  if (req.model.systemPrompt) {
    args.push(`--system-prompt=${req.model.systemPrompt}`);
  }
  if (req.reasoningEffort) {
    args.push("--effort", req.reasoningEffort);
  }
  if (schemaJson !== undefined) {
    args.push(`--json-schema=${schemaJson}`);
  }

  // stream-json serves both streaming and non-streaming Turns through one
  // decoder: a non-streaming Turn never requests partial messages, so the only
  // line carrying text is the final `result` line.
  args.push("--output-format", "stream-json", "--verbose");
  if (req.stream) {
    args.push("--include-partial-messages");
  }

  return args;
}

export const claudeBackend: Backend = {
  label: "claude",
  streaming: true,
  jsonSchema: true,
  run(req: TurnRequest, signal: AbortSignal): TurnRun {
    const schemaJson = req.responseFormat ? JSON.stringify(req.responseFormat.schema) : undefined;
    return runCli(BIN, buildClaudeArgs(req, schemaJson), createClaudeLineDecoder(), signal, {
      cwd: req.workdir,
      apiKeyVars: API_KEY_VARS,
      stdin: req.prompt,
    });
  },
};
