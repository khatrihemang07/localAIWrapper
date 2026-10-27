import { getModel, maxConcurrency, models, modelNames, type ModelConfig, turnTimeoutMs, workdirDefault, workdirRoots } from "./config.ts";
import { getBackend, type TurnRun } from "./backends/index.ts";
import { discoverCommandcodeModels, MODEL_PREFIX, resolveCommandcodeModel } from "./backends/commandcode.ts";
import { AbortedWhileQueuedError, Semaphore } from "./concurrency.ts";
import { type ChatCompletionRequest, type ChatMessage, checkMessages, errorResponse, flattenMessages } from "./openai.ts";
import { bufferedResponse, type ResponseContext, streamResponse } from "./responses.ts";
import { parseRequestOptions } from "./requestOptions.ts";
import { resolveWorkdir } from "./workdir.ts";
import { commandcodeModelList, getOpenAIModel, listOpenAIModels } from "./discovery.ts";

const port = Number(Bun.env.PORT) || 8080;
const host = Bun.env.HOST || "127.0.0.1";

// Caps how many CLI child processes (claude/codex/commandcode) run at once — each one
// costs hundreds of MB. Requests past the cap queue instead of failing; see
// src/concurrency.ts and issue #5.
const cliSlots = new Semaphore(maxConcurrency);


// A Model naming a Backend that doesn't exist must fail at boot, not at the
// first request that asks for it.
for (const [name, cfg] of Object.entries(models)) {
  if (!getBackend(cfg.backend)) {
    throw new Error(`models.json: model "${name}" names unknown backend "${cfg.backend}"`);
  }
}

Bun.serve({
  hostname: host,
  port,
  // Bun closes a connection that goes this many seconds without a byte, and
  // its default is 10 — which is shorter than the gap before the *first*
  // chunk of a real agent Turn. A backend given a large prompt spends that
  // long reading it before it emits any token, so the default silently drops
  // exactly the streaming requests this server exists to carry, while short
  // prompts stream fine and make it look like streaming works. 255 is Bun's
  // own maximum; nothing here wants a shorter one, because a Turn that has
  // genuinely stalled is the client's abort to make, not ours.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChatCompletions(req);
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json(listOpenAIModels());
    }

    // commandcode Models come from the CLI's live catalog, not models.json, so
    // they are listed here rather than under /v1/models (see ./discovery.ts).
    if (req.method === "GET" && url.pathname === "/v1/commandcode/models") {
      try {
        return Response.json(commandcodeModelList(await discoverCommandcodeModels(), url.searchParams.get("q")));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Failed to list commandcode models: ${message}`, 502, "backend_error");
      }
    }

    // Kept as a plain prefix check, matching the exact-string style used
    // everywhere else in this fetch handler — no router/abstraction.
    if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      const id = url.pathname.slice("/v1/models/".length);
      const model = getOpenAIModel(id);
      if (!model) {
        return errorResponse(`Unknown model "${id}". Valid models: ${modelNames().join(", ")}`, 404, "invalid_request_error");
      }
      return Response.json(model);
    }

    return errorResponse("Not found", 404, "not_found_error");
  },
});

console.log(`localAIWrapper listening on http://${host}:${port} (max concurrency ${maxConcurrency}, turn timeout ${turnTimeoutMs}ms)`);

// Per-Turn progress logging (issue: no visibility into whether a slow
// request is queued, running, or hung). turnId correlates every line for one
// request; timestamps let you see where the time actually went.
function makeTurnLogger(turnId: string): (msg: string) => void {
  return (msg: string) => console.log(`[${new Date().toISOString()}] turn=${turnId} ${msg}`);
}

async function handleChatCompletions(req: Request): Promise<Response> {
  const turnId = crypto.randomUUID().slice(0, 8);
  const log = makeTurnLogger(turnId);
  const requestStartedAt = Date.now();
  log("received request");

  let body: ChatCompletionRequest;
  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  if (!body || typeof body.model !== "string") {
    return errorResponse('"model" is required', 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse('"messages" must be a non-empty array', 400);
  }
  const messagesError = checkMessages(body.messages as ChatMessage[]);
  if (messagesError) {
    return errorResponse(messagesError, 400);
  }
  // Tool calling is out of scope (see issue #5): reject loudly rather than
  // silently stripping `tools`/`functions`/`tool_choice` — a client that expects
  // `tool_calls` back would otherwise hang forever waiting for them.
  if (body.tools !== undefined || body.functions !== undefined || body.tool_choice !== undefined) {
    return errorResponse(
      'This server does not support tool calling; requests containing "tools", "functions" or "tool_choice" are rejected rather than silently ignored.',
      400,
    );
  }

  // A commandcode Model is resolved against the CLI's catalog on each request;
  // every other name is looked up in models.json.
  let modelConfig: ModelConfig | undefined;
  if (body.model.startsWith(MODEL_PREFIX)) {
    try {
      const resolved = await resolveCommandcodeModel(body.model);
      if (!resolved.ok) {
        return errorResponse(resolved.message, resolved.status, resolved.type, resolved.code);
      }
      modelConfig = resolved.model;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(`Failed to list commandcode models: ${message}`, 502, "backend_error");
    }
  } else {
    modelConfig = getModel(body.model);
    if (!modelConfig) {
      return errorResponse(
        `Unknown model "${body.model}". Valid models: ${modelNames().join(", ")}`,
        404,
        "invalid_request_error",
      );
    }
  }

  const backend = getBackend(modelConfig.backend);
  if (!backend) {
    return errorResponse(`Unknown backend "${modelConfig.backend}" for model "${body.model}"`, 500, "server_error");
  }

  const parsed = parseRequestOptions(body as unknown as Record<string, unknown>, modelConfig.options);
  if (!parsed.ok) {
    return errorResponse(parsed.message, 400);
  }
  const options = parsed.value;
  if (options.responseFormat && !backend.jsonSchema) {
    return errorResponse(`"response_format" is not supported by the ${backend.label} Backend`, 400);
  }

  // Every Turn runs in a directory the server picked: the configured default,
  // or a requested one that resolves inside WORKDIR_ROOTS.
  let workdir = workdirDefault;
  if (options.workdir !== undefined) {
    const resolvedDir = resolveWorkdir(options.workdir, workdirRoots);
    if (!resolvedDir.ok) {
      return errorResponse(resolvedDir.message, 400);
    }
    workdir = resolvedDir.path;
  }

  const { system, prompt } = flattenMessages(body.messages as ChatMessage[]);
  const effectiveModel = { ...modelConfig, systemPrompt: system ?? modelConfig.systemPrompt };
  const stream = body.stream === true;
  log(`validated: model=${body.model} backend=${backend.label} stream=${stream} access=${options.access} web=${options.web} workdir=${workdir}`);

  // ---- Lifecycle: concurrency cap, timeout, client-disconnect cancellation.
  //
  // One AbortController spans the whole Turn — the queue wait *and* the
  // process's runtime. It's tripped by whichever happens first: the client
  // disconnecting (req.signal) or the per-Turn timeout. Both the
  // concurrency queue (Semaphore.acquire) and the child process listen to
  // it, so an abandoned or overlong Turn never keeps a queue slot or a
  // process alive.
  // Why a Turn stopped before completing normally: "client_disconnected" or
  // "timeout". undefined means it ran to its natural conclusion.
  let abortReason: "client_disconnected" | "timeout" | undefined;
  const turnAbort = new AbortController();

  const onClientAbort = () => {
    abortReason ??= "client_disconnected";
    turnAbort.abort();
  };
  req.signal.addEventListener("abort", onClientAbort);

  const timeoutId = setTimeout(() => {
    abortReason ??= "timeout";
    turnAbort.abort();
  }, turnTimeoutMs);

  if (cliSlots.busy >= maxConcurrency) {
    log(`waiting for a concurrency slot (${cliSlots.busy}/${maxConcurrency} busy, ${cliSlots.queued} ahead in queue)`);
  }
  const acquireStartedAt = Date.now();
  let release: (() => void) | undefined;
  try {
    release = await cliSlots.acquire(turnAbort.signal);
  } catch (err) {
    clearTimeout(timeoutId);
    req.signal.removeEventListener("abort", onClientAbort);
    if (err instanceof AbortedWhileQueuedError) {
      if (abortReason === "timeout") {
        log(`timed out after ${Date.now() - acquireStartedAt}ms waiting for a concurrency slot`);
        return errorResponse(
          `Timed out after ${turnTimeoutMs}ms waiting for a free concurrency slot`,
          504,
          "timeout_error",
        );
      }
      log("client disconnected while queued for a concurrency slot");
      // Client disconnected while still queued: no process was ever
      // spawned, so there's nothing to kill and no slot was taken. The
      // response body is moot since nobody is listening, but return a
      // proper envelope regardless of who (if anyone) reads it.
      return errorResponse("Client disconnected before the request reached a concurrency slot", 499, "client_error");
    }
    throw err;
  }
  const acquireWaitMs = Date.now() - acquireStartedAt;
  if (acquireWaitMs > 50) {
    log(`slot acquired after waiting ${acquireWaitMs}ms`);
  }

  // From here on a slot is held; settle() (defined below) must run exactly
  // once no matter how this Turn ends, to release it and stop the timer.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    req.signal.removeEventListener("abort", onClientAbort);
    release?.();
  };

  // The Backend owns its own execution from here: it spawns its CLI and hands
  // back a TurnRun that listens to turnAbort, so an abandoned or overlong Turn
  // is torn down without this function knowing what process it is killing.
  let run: TurnRun;
  try {
    run = backend.run(
      {
        model: effectiveModel,
        prompt,
        stream,
        reasoningEffort: options.reasoningEffort,
        web: options.web,
        access: options.access,
        workdir,
        responseFormat: options.responseFormat,
      },
      turnAbort.signal,
    );
  } catch (err) {
    // Pre-stream failure (e.g. the binary isn't on PATH): headers were
    // never committed, so this always returns a proper error envelope, even
    // for a streaming request.
    const message = err instanceof Error ? err.message : String(err);
    log(`failed to start ${backend.label}: ${message}`);
    settle();
    return errorResponse(`Failed to start ${backend.label}: ${message}`, 502, "backend_error");
  }
  log(`started ${backend.label}`);

  const responseContext: ResponseContext = {
    model: body.model,
    timeoutMs: turnTimeoutMs,
    getAbortReason: () => abortReason,
    log,
    requestStartedAt,
  };
  if (stream) {
    return streamResponse(run, responseContext, settle);
  }
  try {
    return await bufferedResponse(run, responseContext);
  } finally {
    settle();
  }
}
