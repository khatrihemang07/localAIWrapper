// The only file in this project that knows the `codex` binary exists, or
// what flags it takes. Swapping/updating the CLI is a one-line edit here.
//
// Verified behaviour (measured by live probing, see issue #4):
// - `codex exec --json` emits, in order:
//     thread.started -> turn.started -> item.completed -> turn.completed
//   `item.completed` items of type "agent_message" carry the ENTIRE answer
//   in `item.text` (there are no token deltas — codex delivers one complete
//   message, unlike claude's incremental content_block_delta events). Other
//   item types (e.g. "reasoning", "command_execution") are ignored.
// - `turn.completed` carries `usage.input_tokens` / `usage.output_tokens`.
// - On failure codex emits `turn.failed` (no `turn.completed`) whose
//   `error.message` is itself a JSON-encoded string; exit code is non-zero.
// - `--skip-git-repo-check` is required when run outside a git repository;
//   it is harmless inside one, so it is always passed rather than detecting
//   the cwd.
// - When stdin is not explicitly piped by us, codex still prints a
//   non-JSON "Reading additional input from stdin..." notice — but it goes
//   to stderr, never stdout, so decode() (which only ever sees stdout
//   lines) never receives it. decode() still defensively returns null for
//   any line that doesn't parse as JSON, per the interface contract.
// - `--ephemeral` avoids persisting session files (stateless Turns);
//   `-s read-only` sandboxes the process so it behaves like a plain chat
//   model and can't write to the filesystem.
//
// Argv note: `codex exec` has subcommands (`resume`, `review`) that clap
// matches whenever the first *remaining* positional argument exactly
// equals one of those words, regardless of where in argv it appears or
// what flags surround it (verified: this is not fixed by a `--`
// separator). The prompt passed in here is always the flattened
// "Human: ...\n\nAssistant: ..." transcript built by flattenMessages in
// server.ts, so in practice it can never be exactly "resume" or "review" —
// but `buildArgs` guards against it explicitly anyway (see
// guardReservedPositional below) so it stays safe regardless of how the
// prompt was constructed, rather than relying on that upstream invariant
// holding forever.

import type { ModelConfig } from "../config.ts";
import type { Backend, DecodedLine, Usage } from "./index.ts";

// `codex exec` special-cases a positional argument that matches these
// subcommand names *exactly* (see the file-header note above: verified live,
// not fixed by a `--` separator). Today the prompt is always prefixed with
// "Human: " by flattenMessages, so this can never actually fire — but
// buildArgs must not depend on that invariant holding forever, so guard here
// explicitly regardless of how the prompt was constructed. A trailing space
// is enough to break the exact-match check while leaving the text the model
// receives effectively unchanged.
const RESERVED_POSITIONALS = new Set(["resume", "review"]);

function guardReservedPositional(prompt: string): string {
  return RESERVED_POSITIONALS.has(prompt) ? `${prompt} ` : prompt;
}

function buildArgs(model: ModelConfig, prompt: string, _stream: boolean): string[] {
  const effectivePrompt = guardReservedPositional(
    model.systemPrompt ? `${model.systemPrompt}\n\n${prompt}` : prompt,
  );

  // codex has no incremental mode, so the same args serve every Turn
  // regardless of the requested `stream` value.
  const args: string[] = [
    "exec",
    effectivePrompt,
    "-m",
    model.model,
    "-s",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
  ];

  // The Model's raw, verbatim escape-hatch args (e.g.
  // -c model_reasoning_effort=low for codex-fast) — always appended, never
  // interpreted here.
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

  if (obj?.type === "item.completed" && obj.item?.type === "agent_message") {
    const text = obj.item.text;
    return typeof text === "string" ? { text } : null;
  }

  if (obj?.type === "turn.completed") {
    const usage: Usage | undefined = obj.usage
      ? {
          promptTokens: obj.usage.input_tokens,
          completionTokens: obj.usage.output_tokens,
          totalTokens: (obj.usage.input_tokens ?? 0) + (obj.usage.output_tokens ?? 0),
        }
      : undefined;
    // Always terminal, even if usage is somehow missing — see the `final`
    // doc comment on DecodedLine for why this can't be inferred from usage.
    return { usage, final: true };
  }

  if (obj?.type === "turn.failed") {
    return { error: extractErrorMessage(obj.error), final: true };
  }

  return null;
}

// `error.message` on turn.failed is itself a JSON-encoded string (e.g.
// '{"type":"error","status":400,"error":{"message":"..."}}'); unwrap it
// when possible for a cleaner message, falling back to the raw text.
function extractErrorMessage(error: unknown): string {
  const raw = typeof (error as any)?.message === "string" ? (error as any).message : undefined;
  if (!raw) return "codex CLI reported an error";

  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error?.message;
    if (typeof nested === "string") return nested;
  } catch {
    // raw wasn't JSON — use it as-is.
  }

  return raw;
}

export const codexBackend: Backend = {
  bin: "codex",
  streaming: false,
  buildArgs,
  decode,
};
