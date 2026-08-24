// Loads and validates models.json. Models are declared in config, not code:
// adding a fourth Model requires editing models.json only.

import rawModels from "../models.json";

export type ModelConfig = {
  backend: string;
  model: string;
  systemPrompt?: string;
  args: string[];
  /**
   * Which Transport reaches this Model's Backend. Omitted means "prefer the
   * sdk Transport, fall back to cli if the vendor package won't import".
   * Pin to `"cli"` for a Model whose raw `args` can't be expressed as SDK
   * options, or to keep a Model on the spawn path deliberately.
   *
   * The literal union is duplicated from src/backends/index.ts rather than
   * imported, so that loading config can never depend on a Backend module —
   * those run a top-level `await import(...)` to probe SDK availability.
   */
  transport?: "sdk" | "cli";
};

function validate(raw: unknown): Record<string, ModelConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("models.json must contain a JSON object of model configs");
  }

  const result: Record<string, ModelConfig> = {};

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`models.json: model "${name}" must be an object`);
    }
    const v = value as Record<string, unknown>;

    if (typeof v.backend !== "string" || v.backend.length === 0) {
      throw new Error(`models.json: model "${name}" is missing a string "backend"`);
    }
    if (typeof v.model !== "string" || v.model.length === 0) {
      throw new Error(`models.json: model "${name}" is missing a string "model"`);
    }
    if (v.systemPrompt !== undefined && typeof v.systemPrompt !== "string") {
      throw new Error(`models.json: model "${name}" has a non-string "systemPrompt"`);
    }
    if (!Array.isArray(v.args) || !v.args.every((a) => typeof a === "string")) {
      throw new Error(`models.json: model "${name}" must have an "args" array of strings`);
    }
    if (v.transport !== undefined && v.transport !== "sdk" && v.transport !== "cli") {
      throw new Error(`models.json: model "${name}" has a "transport" that is not "sdk" or "cli"`);
    }

    result[name] = {
      backend: v.backend,
      model: v.model,
      systemPrompt: v.systemPrompt as string | undefined,
      args: v.args as string[],
      transport: v.transport as "sdk" | "cli" | undefined,
    };
  }

  return result;
}

export const models: Record<string, ModelConfig> = validate(rawModels);

export function getModel(name: string): ModelConfig | undefined {
  return models[name];
}

export function modelNames(): string[] {
  return Object.keys(models);
}

// ---- Lifecycle config (issue #5) ------------------------------------------
//
// Every Turn spawns a full CLI process costing hundreds of MB, so both of
// these exist to protect the host machine: a concurrency cap on how many
// run at once, and a timeout so a hung Turn can't hold a slot forever.

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Max number of CLI child processes allowed to run concurrently. Requests
 * past this cap queue rather than fail. Configurable via MAX_CONCURRENCY. */
export const maxConcurrency = positiveIntFromEnv("MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY);

/** Per-Turn wall-clock budget, in ms, covering the queue wait plus the CLI
 * process's runtime. Exceeding it kills the process and returns an error.
 * Configurable via TURN_TIMEOUT_MS. */
export const turnTimeoutMs = positiveIntFromEnv("TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS);
