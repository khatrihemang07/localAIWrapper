// The only file in this project that knows the `claude` binary exists, or
// what flags it takes. Swapping/updating the CLI is a one-line edit here.
//
// Verified behaviour (measured by live probing, see issue #1):
// - `--output-format stream-json` requires `--verbose` when used with `-p`.
// - `--include-partial-messages` is required to get incremental
//   `content_block_delta` events; without it stdout only carries the whole
//   assistant message at once.
// - Text deltas arrive as:
//     {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"…"}}}
// - The final line is:
//     {"type":"result","subtype":"success","result":"…","usage":{…}}

import type { ModelConfig } from "../config.ts";
import type { Backend, DecodedLine, Usage } from "./index.ts";

function buildArgs(model: ModelConfig, prompt: string, stream: boolean): string[] {
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

  // stream-json is used for both streaming and non-streaming turns so a
  // single decode() implementation can serve both: in the non-streaming
  // case we simply never request partial messages, so the only line
  // carrying text is the final "result" line.
  args.push("--output-format", "stream-json", "--verbose");
  if (stream) {
    args.push("--include-partial-messages");
  }

  // The Model's raw, verbatim escape-hatch args (harness-stripping flags,
  // etc.) — always appended, never interpreted here.
  args.push(...model.args);

  return args;
}

function decode(line: string): DecodedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (obj?.type === "stream_event" && obj.event?.type === "content_block_delta") {
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
      error: typeof obj.result === "string" ? obj.result : "claude CLI reported an error",
      usage,
      final: true,
    };
  }

  return null;
}

export const claudeBackend: Backend = {
  bin: "claude",
  streaming: true,
  buildArgs,
  decode,
};
