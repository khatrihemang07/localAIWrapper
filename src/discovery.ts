// Discovery surface: OpenAI's /v1/models (list) and /v1/models/{id}
// (retrieve). Every response here is derived from the loaded config
// (src/config.ts) and the Backend registry (src/backends/index.ts) at
// request time — nothing is hardcoded, so a Model added to models.json
// shows up with no code change.

import { models } from "./config.ts";
import { backends } from "./backends/index.ts";

// Stamped once at process start; used as a stand-in "created" time since
// Models have no real creation timestamp of their own.
const startedAt = Math.floor(Date.now() / 1000);

// The request fields the chat-completions endpoint actually reads (see
// ChatCompletionRequest in src/openai.ts). Every Model is served by the same
// HTTP surface, so this list is uniform across Models; anything else an
// OpenAI client sends (temperature, top_p, max_tokens, ...) is accepted but
// ignored.
const ACCEPTED_OPTIONS = ["model", "messages", "stream"] as const;

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
    options: readonly string[];
  };
};

// The one place that builds a Model's HTTP representation — both list and
// retrieve call this, so they cannot drift apart.
function toOpenAIModel(id: string, cfg: (typeof models)[string]): OpenAIModel {
  const backend = backends[cfg.backend];
  return {
    id,
    object: "model",
    created: startedAt,
    owned_by: cfg.backend,
    local_ai_wrapper: {
      backend: cfg.backend,
      llm: cfg.model,
      // Read off the Backend, never inferred from its name — a Backend with
      // streaming:false (e.g. codex) must fall out of this generically.
      streaming: backend?.streaming ?? false,
      tools: false,
      options: ACCEPTED_OPTIONS,
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
