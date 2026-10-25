// Discovery surface: OpenAI's /v1/models (list) and /v1/models/{id}
// (retrieve). Every response here is derived from the loaded config
// (src/config.ts) and the Backend registry (src/backends/index.ts) at
// request time — nothing is hardcoded, so a Model added to models.json
// shows up with no code change.

import { models, type ModelConfig } from "./config.ts";
import { getBackend } from "./backends/index.ts";
import { type CatalogEntry, MODEL_PREFIX } from "./backends/commandcode.ts";

// Stamped once at process start; used as a stand-in "created" time since
// Models have no real creation timestamp of their own.
const startedAt = Math.floor(Date.now() / 1000);

// Extras live under this single namespaced key rather than flat top-level
// fields — OpenAI can add fields to the model object at any time (`tools` is
// a plausible future collision), and a clash would mean our value silently
// shadowing a real one.
export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  local_ai_wrapper: {
    backend: string;
    llm: string;
    streaming: boolean;
    tools: false;
    /**
     * Per-request options this Model accepts, with what each one allows and
     * what applies when omitted. Taken straight from models.json; see
     * docs/adr/0007. `workdir.default` is always null: the server's configured
     * default directory is deliberately not advertised.
     */
    options: ModelConfig["options"];
    /**
     * How many tokens this Model's underlying model holds, when
     * `models.json` says (`ModelConfig.contextWindow`, src/config.ts).
     * Omitted — not `0` or `null` — when a Model doesn't say, so a client
     * can tell "unknown" from "genuinely tiny" without a sentinel value.
     */
    contextWindow?: number;
  };
};

// The one place that builds a Model's HTTP representation — both list and
// retrieve call this, so they cannot drift apart.
function toOpenAIModel(id: string, cfg: ModelConfig): OpenAIModel {
  // Read off the Backend, never inferred from its name — a Backend with
  // streaming:false (e.g. codex) must fall out of this generically.
  const backend = getBackend(cfg.backend);
  return {
    id,
    object: "model",
    created: startedAt,
    owned_by: cfg.backend,
    local_ai_wrapper: {
      backend: cfg.backend,
      llm: cfg.model,
      streaming: backend?.streaming ?? false,
      tools: false,
      options: cfg.options,
      ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
    },
  };
}

export function listOpenAIModels(): { object: "list"; data: OpenAIModel[] } {
  const data = Object.entries(models).map(([id, cfg]) => toOpenAIModel(id, cfg));
  return { object: "list", data };
}

export function getOpenAIModel(id: string): OpenAIModel | undefined {
  const cfg = models[id];
  if (!cfg) return undefined;
  return toOpenAIModel(id, cfg);
}

// ---- commandcode -----------------------------------------------------------
//
// GET /v1/commandcode/models. Its rows are the CLI's live catalog, so they are
// not in listOpenAIModels: a commandcode Model is named `commandcode/<id>` and
// resolved per request (see src/backends/commandcode.ts).

export type CommandcodeModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: "commandcode";
  local_ai_wrapper: {
    backend: "commandcode";
    /** The text after the id's last "/", which the CLI also accepts. */
    short_name: string;
    /** Reasoning efforts the catalog lists. Omitted when no catalog metadata is available. */
    efforts?: string[];
    /** Omitted when the catalog says nothing. */
    contextWindow?: number;
    default: boolean;
  };
};

/**
 * The OpenAI-style list for a catalog, filtered by `q`: a case-insensitive
 * substring of the id. A missing or empty `q` keeps every row.
 */
export function commandcodeModelList(
  entries: CatalogEntry[],
  q: string | null,
): { object: "list"; data: CommandcodeModel[] } {
  const needle = (q ?? "").toLowerCase();
  const data = entries
    .filter((e) => e.id.toLowerCase().includes(needle))
    .map((e): CommandcodeModel => ({
      id: `${MODEL_PREFIX}${e.id}`,
      object: "model",
      created: startedAt,
      owned_by: "commandcode",
      local_ai_wrapper: {
        backend: "commandcode",
        short_name: e.shortName,
        ...(e.efforts !== undefined ? { efforts: e.efforts } : {}),
        ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow } : {}),
        default: e.isDefault,
      },
    }));
  return { object: "list", data };
}
