// Discovery surface: OpenAI's /v1/models (list) and /v1/models/{id}
// (retrieve). Every response here is derived from the loaded config
// (src/config.ts) and the Backend registry (src/backends/index.ts) at
// request time — nothing is hardcoded, so a Model added to models.json
// shows up with no code change.

import { models } from "./config.ts";
import { resolveBackend } from "./backends/index.ts";

// Stamped once at process start; used as a stand-in "created" time since
// Models have no real creation timestamp of their own.
const startedAt = Math.floor(Date.now() / 1000);

// The request fields the chat-completions endpoint actually reads (see
// ChatCompletionRequest in src/openai.ts). Every Model is served by the same
// HTTP surface, so this list is uniform across Models; anything else an
// OpenAI client sends (temperature, top_p, max_tokens, ...) is accepted but
// ignored.
const ACCEPTED_OPTIONS = ["model", "messages", "stream", "reasoning_effort"] as const;

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
    /**
     * How this server reaches the Backend: the vendor SDK, or a spawned CLI.
     * Advertised because it is observable — the two Transports can differ in
     * prompt overhead and in which binary version actually answers.
     */
    transport: string;
    streaming: boolean;
    tools: false;
    options: readonly string[];
    /**
     * How many tokens this Model's underlying model holds, when
     * `models.json` says (`ModelConfig.contextWindow`, src/config.ts).
     * Omitted — not `0` or `null` — when a Model doesn't say, so a client
     * can tell "unknown" from "genuinely tiny" without a sentinel value.
     * Added for meologue issue #97, which reads this with a conservative
     * fallback for exactly that omitted case.
     */
    contextWindow?: number;
  };
};

// The one place that builds a Model's HTTP representation — both list and
// retrieve call this, so they cannot drift apart.
function toOpenAIModel(id: string, cfg: (typeof models)[string]): OpenAIModel {
  // Resolved rather than looked up, so what's advertised is the Transport
  // that would actually serve a request — including a fallback to cli when
  // the SDK package isn't importable.
  const resolved = resolveBackend(cfg.backend, cfg.transport);
  return {
    id,
    object: "model",
    created: startedAt,
    owned_by: cfg.backend,
    local_ai_wrapper: {
      backend: cfg.backend,
      llm: cfg.model,
      transport: resolved?.transport ?? "cli",
      // Read off the Backend, never inferred from its name — a Backend with
      // streaming:false (e.g. codex) must fall out of this generically.
      streaming: resolved?.backend.streaming ?? false,
      tools: false,
      options: ACCEPTED_OPTIONS,
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
