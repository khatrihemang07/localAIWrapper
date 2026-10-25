// Loads and validates models.json and the server's working-directory config.
// Models are declared in config, not code: adding a fourth Model requires
// editing models.json only.

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import rawModels from "../models.json";

/** Names of the per-request options a Model can declare (see docs/adr/0007). */
export const OPTION_NAMES = ["reasoning_effort", "web", "access", "workdir"] as const;
export type OptionName = (typeof OPTION_NAMES)[number];

/**
 * What one Model says about one per-request option. `values` lists the
 * accepted values (`null` for free-form `workdir`); `default` is what applies
 * when the request omits the option (`null` = the backend's own default).
 */
export type OptionSpec = {
  supported: boolean;
  values: Array<string | boolean> | null;
  default: string | boolean | null;
  description: string;
};

export type ModelOptions = Record<OptionName, OptionSpec>;

export type ModelConfig = {
  backend: string;
  model: string;
  systemPrompt?: string;
  /**
   * How many tokens the underlying model's own context window holds.
   * Optional and otherwise unused by this server — nothing here trims a
   * Turn to fit it — surfaced purely as `local_ai_wrapper.contextWindow` on
   * this Model's `GET /v1/models`/`GET /v1/models/{id}` entry (see
   * src/discovery.ts) so a client can size its own context budget instead
   * of guessing. Added for meologue issue #97, which reads it with a
   * conservative fallback when a Model omits it.
   */
  contextWindow?: number;
  options: ModelOptions;
};

/**
 * The value an option takes when it is not in effect. An unsupported option
 * must declare exactly this as its default, and a request may send exactly
 * this value for it (see src/requestOptions.ts).
 */
const NEUTRAL: Record<OptionName, string | boolean | null> = {
  reasoning_effort: null,
  web: false,
  access: "none",
  workdir: null,
};

/**
 * Option declarations every Model of a Backend shares. A Model's own
 * `options` entry replaces the option it names; any option it omits comes from
 * here. models.json therefore only lists what differs between Models.
 */
const BACKEND_OPTION_DEFAULTS: Record<string, Partial<Record<OptionName, unknown>>> = {
  "claude": {
    "reasoning_effort": {
      "supported": true,
      "values": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "default": null,
      "description": "Reasoning effort passed to claude --effort. Omit for the CLI default."
    },
    "web": {
      "supported": true,
      "values": [
        false,
        true
      ],
      "default": false,
      "description": "Allow web search and page fetch tools (WebSearch, WebFetch)."
    },
    "access": {
      "supported": true,
      "values": [
        "none",
        "read-only",
        "workspace-write"
      ],
      "default": "none",
      "description": "none (default): no file tools. read-only: adds Read, Glob, Grep. workspace-write: also Edit and Write. These tools are not a sandbox: they accept absolute paths, so access does not confine the Turn to its workdir (docs/adr/0007)."
    },
    "workdir": {
      "supported": true,
      "values": null,
      "default": null,
      "description": "Absolute directory the Turn runs in. Must resolve inside WORKDIR_ROOTS. Omit for WORKDIR_DEFAULT."
    }
  },
  "codex": {
    "reasoning_effort": {
      "supported": true,
      "values": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "default": null,
      "description": "Reasoning effort passed as codex -c model_reasoning_effort. Omit for the CLI default."
    },
    "web": {
      "supported": true,
      "values": [
        false,
        true
      ],
      "default": false,
      "description": "Enable live web search (codex -c web_search=live). Off by default."
    },
    "access": {
      "supported": true,
      "values": [
        "read-only",
        "workspace-write"
      ],
      "default": "read-only",
      "description": "read-only (default): codex read-only sandbox, so no writes; codex read-only can still read outside workdir (only writes are confined). workspace-write: codex sandbox that confines writes to workdir."
    },
    "workdir": {
      "supported": true,
      "values": null,
      "default": null,
      "description": "Absolute directory the Turn runs in. Must resolve inside WORKDIR_ROOTS. Omit for WORKDIR_DEFAULT."
    }
  }
};

/** The keys a Model entry may carry. Anything else fails the boot by name. */
const MODEL_KEYS = ["backend", "model", "systemPrompt", "contextWindow", "options"];
/** The keys an option spec may carry. Anything else fails the boot by name. */
const OPTION_SPEC_KEYS = ["supported", "values", "default", "description"];
const KNOWN_BACKENDS = Object.keys(BACKEND_OPTION_DEFAULTS);

function validateOption(modelName: string, name: OptionName, raw: unknown): OptionSpec {
  const where = `models.json: model "${modelName}" option "${name}"`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!OPTION_SPEC_KEYS.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
  }
  if (typeof o.supported !== "boolean") throw new Error(`${where} needs a boolean "supported"`);
  if (typeof o.description !== "string") throw new Error(`${where} needs a string "description"`);
  if (o.values !== null && o.values !== undefined) {
    if (!Array.isArray(o.values) || !o.values.every((v) => typeof v === "string" || typeof v === "boolean")) {
      throw new Error(`${where} "values" must be null or an array of strings/booleans`);
    }
  }
  const values = (o.values ?? null) as Array<string | boolean> | null;
  // Every option except the free-form workdir enumerates its values.
  if (o.supported && name !== "workdir" && (values === null || values.length === 0)) {
    throw new Error(`${where} is supported, so it needs a non-empty "values" array`);
  }
  const def = (o.default ?? null) as string | boolean | null;
  if (def !== null && values !== null && !values.includes(def)) {
    throw new Error(`${where} "default" is not one of its "values"`);
  }
  if (name === "workdir" && def !== null) {
    throw new Error(`${where} "default" must be null: the configured default directory is not advertised`);
  }
  if (!o.supported && def !== NEUTRAL[name]) {
    throw new Error(`${where} is unsupported, so its "default" must be ${JSON.stringify(NEUTRAL[name])}`);
  }
  return { supported: o.supported, values, default: def, description: o.description };
}

/** Validates raw models.json content. Exported so the boot checks can be tested. */
export function validateModels(raw: unknown): Record<string, ModelConfig> {
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
    // Checked first, so a Model naming a Backend that does not exist gets that
    // as its error, whatever else is wrong with it.
    if (!KNOWN_BACKENDS.includes(v.backend)) {
      throw new Error(
        `models.json: model "${name}" names unknown backend "${v.backend}" (known: ${KNOWN_BACKENDS.join(", ")})`,
      );
    }
    for (const key of Object.keys(v)) {
      if (!MODEL_KEYS.includes(key)) throw new Error(`models.json: model "${name}" has unknown key "${key}"`);
    }
    if (typeof v.model !== "string" || v.model.length === 0) {
      throw new Error(`models.json: model "${name}" is missing a string "model"`);
    }
    if (v.systemPrompt !== undefined && typeof v.systemPrompt !== "string") {
      throw new Error(`models.json: model "${name}" has a non-string "systemPrompt"`);
    }
    if (v.contextWindow !== undefined && (typeof v.contextWindow !== "number" || v.contextWindow <= 0)) {
      throw new Error(`models.json: model "${name}" has a "contextWindow" that is not a positive number`);
    }
    if (v.options !== undefined && (typeof v.options !== "object" || v.options === null || Array.isArray(v.options))) {
      throw new Error(`models.json: model "${name}" has an "options" value that is not an object`);
    }
    if (v.options !== undefined) {
      for (const key of Object.keys(v.options as object)) {
        if (!(OPTION_NAMES as readonly string[]).includes(key)) {
          throw new Error(`models.json: model "${name}" has unknown option "${key}"`);
        }
      }
    }
    const opts: Record<string, unknown> = {
      ...(BACKEND_OPTION_DEFAULTS[v.backend] ?? {}),
      ...((v.options ?? {}) as Record<string, unknown>),
    };
    const options = {} as ModelOptions;
    for (const option of OPTION_NAMES) {
      options[option] = validateOption(name, option, opts[option]);
    }

    result[name] = {
      backend: v.backend,
      model: v.model,
      systemPrompt: v.systemPrompt as string | undefined,
      contextWindow: v.contextWindow as number | undefined,
      options,
    };
  }

  return result;
}

export const models: Record<string, ModelConfig> = validateModels(rawModels);

export function getModel(name: string): ModelConfig | undefined {
  return models[name];
}

export function modelNames(): string[] {
  return Object.keys(models);
}

// ---- Working directory config ----------------------------------------------
//
// Every Turn runs in a directory the server chooses, never the server's own
// cwd. WORKDIR_DEFAULT is used when a request omits `workdir`; a request may
// name another directory only if it resolves inside one of WORKDIR_ROOTS.
// The default directory is always a root, so the default is always allowed.

function defaultWorkdirFromEnv(): string {
  return Bun.env.WORKDIR_DEFAULT || join(homedir(), ".local", "share", "localAIWrapper", "workdir");
}

/** Resolves a configured directory to its realpath, creating the default if missing. */
function resolveConfiguredDir(label: string, dir: string, create: boolean): string {
  if (create) mkdirSync(dir, { recursive: true });
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new Error(`${label} "${dir}" does not exist`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`${label} "${dir}" is not a directory`);
  }
  return real;
}

const rawDefault = defaultWorkdirFromEnv();
const rawRoots = (Bun.env.WORKDIR_ROOTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The directory a Turn runs in when its request names no `workdir`. */
// Only the built-in default is created on demand; a directory the operator
// named must already exist.
export const workdirDefault = resolveConfiguredDir("WORKDIR_DEFAULT", rawDefault, !Bun.env.WORKDIR_DEFAULT);

/** Every directory a request's `workdir` may resolve into (realpaths). */
export const workdirRoots: readonly string[] = [
  ...new Set([workdirDefault, ...rawRoots.map((r) => resolveConfiguredDir("WORKDIR_ROOTS entry", r, false))]),
];

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
