// The only file in this project that knows the `codex` binary exists, what
// flags it takes, or which environment variables it reads for billing.
//
// Verified CLI behaviour (live probing, see issue #4 and docs/adr/0007):
// - `codex exec --json` emits, in order:
//     thread.started -> turn.started -> item.completed -> turn.completed
//   `item.completed` items of type "agent_message" carry the ENTIRE answer
//   in `item.text` (no token deltas). Other item types are ignored.
// - `turn.completed` carries `usage.input_tokens` / `usage.output_tokens`.
// - On failure codex emits `turn.failed` (no `turn.completed`) whose
//   `error.message` is itself a JSON-encoded string; exit code is non-zero.
// - `--skip-git-repo-check` is required when run outside a git repository;
//   it is harmless inside one, so it is always passed.
// - `--output-schema <file>` makes the final agent message conform to the
//   schema in that file (verified: the agent_message text is the JSON).
// - `-s read-only` blocks writes; `-s workspace-write` allows them inside
//   `-C <dir>` (verified both ways).
// - `-c web_search="live"|"disabled"` controls web search. The value set is
//   disabled|cached|indexed|live; an unknown value is rejected at config load,
//   so the key is confirmed recognised.
// - `--ephemeral` avoids persisting session files (stateless Turns).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "../config.ts";
import type { Backend, DecodedLine, TurnRequest, TurnRun } from "./index.ts";
import { jsonLineDecoder, runCli, toUsage } from "./cli.ts";

const BIN = "codex";

/** Credentials that would make `codex` bill API usage instead of the plan. */
const API_KEY_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];

// ---- decoding --------------------------------------------------------------

function decodeEvent(obj: any): DecodedLine | null {
  if (obj?.type === "item.completed" && obj.item?.type === "agent_message") {
    const text = obj.item.text;
    return typeof text === "string" ? { text } : null;
  }

  if (obj?.type === "turn.completed") {
    const usage = toUsage(obj.usage);
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
 * codex has no system-prompt flag, so the system prompt is prepended to the
 * user prompt.
 */
function composePrompt(model: ModelConfig, prompt: string): string {
  return model.systemPrompt ? `${model.systemPrompt}\n\n${prompt}` : prompt;
}

// ---- invocation ------------------------------------------------------------

/**
 * codex's access values map straight onto its sandbox. Its read-only sandbox
 * can still READ outside the workdir; only writes are confined (see
 * docs/adr/0007).
 */
export function sandboxFor(access: TurnRequest["access"]): "read-only" | "workspace-write" {
  return access === "workspace-write" ? "workspace-write" : "read-only";
}

/**
 * The argv for one Turn. `exec -` reads the prompt from stdin (see the codex
 * --help: "-" or no PROMPT means stdin), so no prompt text is ever an argv
 * token and a subcommand-like prompt cannot be mistaken for one.
 */
export function buildCodexArgs(req: TurnRequest, schemaFile?: string): string[] {
  const args: string[] = [
    "exec",
    "-",
    "-m",
    req.model.model,
    "-s",
    sandboxFor(req.access),
    "-C",
    req.workdir,
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    // Set explicitly both ways so a user's own ~/.codex config cannot turn
    // web search on for a request that did not ask for it.
    "-c",
    `web_search="${req.web ? "live" : "disabled"}"`,
  ];

  if (req.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${req.reasoningEffort}`);
  }
  if (schemaFile !== undefined) {
    args.push("--output-schema", schemaFile);
  }

  return args;
}

export const codexBackend: Backend = {
  label: "codex",
  // Measured: codex emits no token deltas, so the whole answer arrives as one
  // message and is relayed as one chunk.
  streaming: false,
  jsonSchema: true,
  run(req: TurnRequest, signal: AbortSignal): TurnRun {
    // The schema goes to codex as a file. It is created per Turn and removed
    // once the process has finished — or straight away if it never started.
    let schemaDir: string | undefined;
    let schemaFile: string | undefined;
    const cleanup = () => {
      if (schemaDir !== undefined) rmSync(schemaDir, { recursive: true, force: true });
      schemaDir = undefined;
    };
    if (req.responseFormat) {
      schemaDir = mkdtempSync(join(tmpdir(), "localaiwrapper-schema-"));
      schemaFile = join(schemaDir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(req.responseFormat.schema));
    }

    try {
      return runCli(BIN, buildCodexArgs(req, schemaFile), decodeLine, signal, {
        cwd: req.workdir,
        apiKeyVars: API_KEY_VARS,
        cleanup,
        stdin: composePrompt(req.model, req.prompt),
      });
    } catch (err) {
      cleanup();
      throw err;
    }
  },
};
