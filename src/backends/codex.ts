// The only file in this project that knows the `codex` binary exists, what
// flags it takes, or that @openai/codex-sdk exists.
//
// Two Transports, one decoder. The SDK's README states outright that it
// "wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges
// JSONL events over stdin/stdout", and its ThreadEvent union is the same
// `item.completed` / `turn.completed` / `turn.failed` shape the CLI prints. So
// decodeEvent() below serves both Transports.
//
// Verified CLI behaviour (measured by live probing, see issue #4):
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
//   to stderr, never stdout, so decodeLine() (which only ever sees stdout
//   lines) never receives it. It still defensively returns null for any line
//   that doesn't parse as JSON, per the interface contract.
// - `--ephemeral` avoids persisting session files (stateless Turns);
//   `-s read-only` sandboxes the process so it behaves like a plain chat
//   model and can't write to the filesystem.
//
// Verified SDK behaviour (measured live, see docs/adr/0006):
// - Authenticates against an existing ChatGPT login (~/.codex/auth.json,
//   `auth_mode: "chatgpt"`) with no API key. `CodexOptions.apiKey` is
//   optional and nothing is injected unless it is supplied.
// - STILL NO TOKEN DELTAS. `runStreamed()` was measured emitting zero
//   `item.updated` events — the whole answer arrives in one
//   `item.completed`. So `streaming` stays false on both Transports; there
//   are not even snapshots to diff into deltas.
// - THERE IS NO `--ephemeral` EQUIVALENT. ThreadOptions has no such option
//   and the SDK docs state threads persist in ~/.codex/sessions. Measured:
//   one session file written per Turn. This is a real regression against the
//   cli Transport, accepted as disk cost rather than correctness cost —
//   ADR-0001's statelessness still holds, because a fresh thread is started
//   per Turn and resumeThread() is never called.
// - The SDK writes the prompt to stdin rather than argv, so the `resume` /
//   `review` positional collision guarded below cannot arise on that path.
//
// Argv note (cli Transport only): `codex exec` has subcommands (`resume`,
// `review`) that clap matches whenever the first *remaining* positional
// argument exactly equals one of those words, regardless of where in argv it
// appears or what flags surround it (verified: this is not fixed by a `--`
// separator). The prompt passed in here is always the flattened
// "Human: ...\n\nAssistant: ..." transcript built by flattenMessages in
// server.ts, so in practice it can never be exactly "resume" or "review" —
// but buildArgs guards against it explicitly anyway (see
// guardReservedPositional below) so it stays safe regardless of how the
// prompt was constructed, rather than relying on that upstream invariant
// holding forever.

import type { ModelConfig } from "../config.ts";
import type { Backend, DecodedLine, TurnRequest, TurnRun, Usage } from "./index.ts";
import { jsonLineDecoder, runCli } from "./cli.ts";
import { pairArgs, runSdkTurn } from "./sdk.ts";

const BIN = "codex";

// ---- shared decoding -------------------------------------------------------

function decodeEvent(obj: any): DecodedLine | null {
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

const decodeLine = jsonLineDecoder(decodeEvent);

// `error.message` on turn.failed is itself a JSON-encoded string (e.g.
// '{"type":"error","status":400,"error":{"message":"..."}}'); unwrap it
// when possible for a cleaner message, falling back to the raw text.
function extractErrorMessage(error: unknown): string {
  const raw = typeof (error as any)?.message === "string" ? (error as any).message : undefined;
  if (!raw) return "codex reported an error";

  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error?.message;
    if (typeof nested === "string") return nested;
  } catch {
    // raw wasn't JSON — use it as-is.
  }

  return raw;
}

/**
 * codex has no system-prompt flag and the SDK has no systemPrompt option
 * either, so on both Transports the system prompt is prepended to the user
 * prompt. Kept in one place so the two can't drift.
 */
function composePrompt(model: ModelConfig, prompt: string): string {
  return model.systemPrompt ? `${model.systemPrompt}\n\n${prompt}` : prompt;
}

// ---- cli Transport ---------------------------------------------------------

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

function buildArgs(model: ModelConfig, prompt: string, _stream: boolean, reasoningEffort?: string): string[] {
  const effectivePrompt = guardReservedPositional(composePrompt(model, prompt));

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
  // -c model_reasoning_effort=low) — always appended, never interpreted here.
  args.push(...model.args);

  // Per-request override from the chat-completions body, appended after the
  // Model's static args so it wins if both set model_reasoning_effort (see
  // docs/adr/0005-reasoning-effort-per-request.md).
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }

  return args;
}

export const codexCliBackend: Backend = {
  label: "codex (cli)",
  streaming: false,
  run(req: TurnRequest, signal: AbortSignal): TurnRun {
    const args = buildArgs(req.model, req.prompt, req.stream, req.reasoningEffort);
    return runCli(BIN, args, decodeLine, signal);
  },
};

// ---- sdk Transport ---------------------------------------------------------

/**
 * codex's raw escape-hatch args are `-c key=value` config overrides, which the
 * SDK accepts verbatim as `configOverrides`. Any other flag is a hard error
 * rather than a silent drop, for the same reason as the claude Backend: a
 * dropped sandbox or budget flag produces a Turn that still looks like it
 * worked.
 */
const CODEX_VALUE_FLAGS = new Set(["-c", "--config"]);

function translateArgs(model: ModelConfig): string[] {
  const overrides: string[] = [];
  const pairs = pairArgs(model.args, (flag) => CODEX_VALUE_FLAGS.has(flag));

  for (const { flag, value } of pairs) {
    if (!CODEX_VALUE_FLAGS.has(flag)) {
      throw new Error(
        `codex Backend: cannot express "${flag}" as an SDK option. ` +
          `Only ${[...CODEX_VALUE_FLAGS].join(" / ")} config overrides translate; ` +
          `pin this Model with "transport": "cli" in models.json to keep using it.`,
      );
    }
    if (value === undefined) {
      throw new Error(`codex Backend: "${flag}" in models.json is missing its value`);
    }
    overrides.push(value);
  }

  return overrides;
}

export function validateCodexSdkArgs(model: ModelConfig): void {
  translateArgs(model);
}

// Import once at startup. A package that won't load is the *only* condition
// that falls back to the cli Transport (see resolveBackend in ./index.ts).
let sdk: { Codex: new (options?: any) => any } | null = null;
try {
  sdk = (await import("@openai/codex-sdk")) as any;
} catch {
  sdk = null;
}

export const codexSdkBackend: Backend | null = sdk
  ? {
      label: "codex (sdk)",
      // Measured: runStreamed() emits zero item.updated events, so there is
      // nothing incremental to relay. Same as the cli Transport.
      streaming: false,
      run(req: TurnRequest, signal: AbortSignal): TurnRun {
        const configOverrides = translateArgs(req.model);

        return runSdkTurn(
          BIN,
          async function* (abortSignal) {
            const codex = new sdk!.Codex({ configOverrides });
            const thread = codex.startThread({
              model: req.model.model,
              sandboxMode: "read-only",
              skipGitRepoCheck: true,
              // The typed thread option, not another entry appended to
              // configOverrides. The SDK documents configOverrides as applied
              // "before SDK-managed or thread-specific overrides", so this is
              // *documented* to win over a Model's static
              // `-c model_reasoning_effort=...` — which is the precedence
              // ADR-0005 requires. Appending a second raw override instead
              // would rest the same guarantee on an unverified assumption
              // that repeated --config flags resolve last-wins.
              ...(req.reasoningEffort ? { modelReasoningEffort: req.reasoningEffort } : {}),
            });
            const { events } = await thread.runStreamed(composePrompt(req.model, req.prompt), {
              signal: abortSignal,
            });
            for await (const event of events) {
              const decoded = decodeEvent(event);
              if (decoded) yield decoded;
            }
          },
          signal,
        );
      },
    }
  : null;
