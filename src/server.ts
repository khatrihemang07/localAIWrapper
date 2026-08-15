import { getModel, maxConcurrency, modelNames, turnTimeoutMs } from "./config.ts";
import { backends, type Backend, type Usage } from "./backends/index.ts";
import { AbortedWhileQueuedError, Semaphore } from "./concurrency.ts";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ReasoningEffort,
  completionId,
  errorResponse,
  flattenMessages,
  sseFrame,
  SSE_DONE,
} from "./openai.ts";
import { getOpenAIModel, listOpenAIModels } from "./discovery.ts";

const port = Number(Bun.env.PORT) || 8080;

// Caps how many CLI child processes (claude/codex) run at once — each one
// costs hundreds of MB. Requests past the cap queue instead of failing; see
// src/concurrency.ts and issue #5.
const cliSlots = new Semaphore(maxConcurrency);

// Why a Turn stopped waiting/running before completing normally. Used to
// pick the right error message; `undefined` means it ran to its natural
// conclusion (success or a backend-reported failure).
type AbortReason = "client_disconnected" | "timeout";

const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

Bun.serve({
  hostname: "127.0.0.1",
  port,
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

console.log(`localAIWrapper listening on http://127.0.0.1:${port} (max concurrency ${maxConcurrency}, turn timeout ${turnTimeoutMs}ms)`);

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
  // Tool calling is out of scope (see issue #5): reject loudly rather than
  // silently stripping `tools`/`functions` — a client that expects
  // `tool_calls` back would otherwise hang forever waiting for them.
  if (body.tools !== undefined || body.functions !== undefined) {
    return errorResponse(
      'This server does not support tool calling; requests containing "tools" or "functions" are rejected rather than silently ignored.',
      400,
    );
  }
  if (body.reasoning_effort !== undefined && !REASONING_EFFORTS.has(body.reasoning_effort)) {
    return errorResponse(`"reasoning_effort" must be one of: ${[...REASONING_EFFORTS].join(", ")}`, 400);
  }

  const modelConfig = getModel(body.model);
  if (!modelConfig) {
    return errorResponse(
      `Unknown model "${body.model}". Valid models: ${modelNames().join(", ")}`,
      404,
      "invalid_request_error",
    );
  }

  const backend = backends[modelConfig.backend];
  if (!backend) {
    return errorResponse(`Unknown backend "${modelConfig.backend}" for model "${body.model}"`, 500, "server_error");
  }

  const { system, prompt } = flattenMessages(body.messages as ChatMessage[]);
  const effectiveModel = { ...modelConfig, systemPrompt: system ?? modelConfig.systemPrompt };
  const stream = body.stream === true;
  log(`validated: model=${body.model} backend=${modelConfig.backend} stream=${stream}`);

  // ---- Lifecycle: concurrency cap, timeout, client-disconnect cancellation.
  //
  // One AbortController spans the whole Turn — the queue wait *and* the
  // process's runtime. It's tripped by whichever happens first: the client
  // disconnecting (req.signal) or the per-Turn timeout. Both the
  // concurrency queue (Semaphore.acquire) and the child process listen to
  // it, so an abandoned or overlong Turn never keeps a queue slot or a
  // process alive.
  let abortReason: AbortReason | undefined;
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

  const args = backend.buildArgs(effectiveModel, prompt, stream, body.reasoning_effort);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([backend.bin, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    // Pre-stream failure (e.g. the binary isn't on PATH): headers were
    // never committed, so this always returns a proper error envelope, even
    // for a streaming request.
    log(`failed to spawn ${backend.bin}: ${err instanceof Error ? err.message : String(err)}`);
    settle();
    return errorResponse(
      `Failed to start ${backend.bin}: ${err instanceof Error ? err.message : String(err)}`,
      502,
      "backend_error",
    );
  }
  log(`spawned ${backend.bin} pid=${proc.pid}`);

  // Kill the process the moment the Turn is aborted for any reason
  // (disconnect or timeout). Covers the small race between acquiring the
  // slot and spawning, and — for the non-streaming path, which has no
  // ReadableStream cancel() hook of its own — is the *only* thing that
  // kills the process on disconnect.
  if (turnAbort.signal.aborted) {
    proc.kill();
  }
  const killOnAbort = () => proc.kill();
  turnAbort.signal.addEventListener("abort", killOnAbort);
  const cleanup = () => {
    turnAbort.signal.removeEventListener("abort", killOnAbort);
    settle();
  };

  // Drain stderr concurrently so the pipe never backs up; keep the tail in
  // case the process exits without a decodable error line.
  let stderrText = "";
  const stderrDrain = (async () => {
    for await (const chunk of readLines(proc.stderr)) {
      stderrText += chunk + "\n";
    }
  })();

  if (stream) {
    return streamResponse(
      proc,
      backend,
      body.model,
      stderrDrain,
      () => stderrText,
      () => abortReason,
      cleanup,
      log,
      requestStartedAt,
    );
  }
  try {
    return await bufferedResponse(proc, backend, body.model, stderrDrain, () => stderrText, () => abortReason, log, requestStartedAt);
  } finally {
    cleanup();
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

// Only the last STDERR_TAIL_CHARS of stderr are surfaced to the client —
// "the tail", per issue #5 — so a runaway or noisy CLI can't blow up the
// error envelope.
const STDERR_TAIL_CHARS = 4000;

function stderrTail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? trimmed.slice(-STDERR_TAIL_CHARS) : trimmed;
}

function withStderrTail(message: string, stderr: string): string {
  const tail = stderrTail(stderr);
  return tail ? `${message} (stderr: ${tail})` : message;
}

function usageChunkPayload(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens ?? 0,
    completion_tokens: usage.completionTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
  };
}

async function bufferedResponse(
  proc: ReturnType<typeof Bun.spawn>,
  backend: Backend,
  model: string,
  stderrDrain: Promise<void>,
  getStderr: () => string,
  getAbortReason: () => AbortReason | undefined,
  log: (msg: string) => void,
  requestStartedAt: number,
): Promise<Response> {
  let text = "";
  let usage: Usage | undefined;
  let error: string | undefined;

  for await (const line of readLines(proc.stdout)) {
    const decoded = backend.decode(line);
    if (!decoded) continue;
    if (typeof decoded.text === "string") text = decoded.text;
    if (decoded.usage) usage = decoded.usage;
    if (decoded.error) error = decoded.error;
  }

  const exitCode = await proc.exited;
  await stderrDrain;
  const elapsedMs = Date.now() - requestStartedAt;

  if (getAbortReason() === "timeout") {
    log(`timed out after ${elapsedMs}ms, process killed`);
    return errorResponse(
      `Turn exceeded the configured timeout (${turnTimeoutMs}ms) and was terminated`,
      504,
      "timeout_error",
    );
  }

  if (error) {
    log(`backend reported an error after ${elapsedMs}ms: ${error}`);
    return errorResponse(withStderrTail(error, getStderr()), 502, "backend_error");
  }
  if (exitCode !== 0) {
    log(`${backend.bin} exited with code ${exitCode} after ${elapsedMs}ms`);
    return errorResponse(stderrTail(getStderr()) || `${backend.bin} exited with code ${exitCode}`, 502, "backend_error");
  }

  log(`completed in ${elapsedMs}ms`);
  const response: ChatCompletionResponse = {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
  if (usage) {
    response.usage = usageChunkPayload(usage);
  }
  return Response.json(response);
}

function streamResponse(
  proc: ReturnType<typeof Bun.spawn>,
  backend: Backend,
  model: string,
  stderrDrain: Promise<void>,
  getStderr: () => string,
  getAbortReason: () => AbortReason | undefined,
  onSettled: () => void,
  log: (msg: string) => void,
  requestStartedAt: number,
): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  // Set by the ReadableStream's cancel() hook, which Bun invokes when the
  // client disconnects mid-stream (verified live — see test.sh's
  // "mid-stream disconnect" check). Once set, further controller
  // enqueue/close calls are skipped: the underlying controller may already
  // be torn down, and there is no one left to read the bytes anyway.
  let cancelled = false;

  // Deduplicates onSettled() between the normal completion path (the
  // `finally` below) and cancel(), which can both fire.
  let settledOnce = false;
  const settle = () => {
    if (settledOnce) return;
    settledOnce = true;
    onSettled();
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sentRole = false;
      let sawError: string | undefined;
      let usage: Usage | undefined;

      const safeEnqueue = (chunk: string) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Consumer tore the stream down concurrently; nothing to do.
        }
      };

      try {
        for await (const line of readLines(proc.stdout)) {
          const decoded = backend.decode(line);
          if (!decoded) continue;

          if (decoded.error) {
            sawError = decoded.error;
            if (decoded.usage) usage = decoded.usage;
            break;
          }
          // Stop on the explicit terminal marker, never on "usage is
          // present" — see the `final` doc comment on DecodedLine.
          if (decoded.final) {
            if (decoded.usage) usage = decoded.usage;
            break;
          }
          if (decoded.text) {
            const delta: { role?: "assistant"; content?: string } = { content: decoded.text };
            if (!sentRole) {
              delta.role = "assistant";
              sentRole = true;
            }
            safeEnqueue(
              sseFrame({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta, finish_reason: null }],
              }),
            );
          }
        }

        const exitCode = await proc.exited;
        await stderrDrain;
        const elapsedMs = Date.now() - requestStartedAt;

        const abortReason = getAbortReason();
        if (!sawError && abortReason === "timeout") {
          sawError = `Turn exceeded the configured timeout (${turnTimeoutMs}ms) and was terminated`;
        } else if (!sawError && exitCode !== 0 && abortReason !== "client_disconnected") {
          sawError = withStderrTail(`${backend.bin} exited with code ${exitCode}`, getStderr());
        }

        if (cancelled) {
          log(`client disconnected mid-stream after ${elapsedMs}ms`);
          // Client already gone: nothing left to emit.
          return;
        }

        log(sawError ? `stream ended with an error after ${elapsedMs}ms: ${sawError}` : `stream completed in ${elapsedMs}ms`);

        // Always emit a real usage count ahead of the terminal chunk, as an
        // extra chunk with empty `choices` (OpenAI's convention for
        // `stream_options.include_usage`). We don't gate this on that
        // option being set — honest usage being unconditionally available
        // is more useful here than matching that opt-in exactly. See ADR
        // 0003.
        if (usage) {
          safeEnqueue(
            sseFrame({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [],
              usage: usageChunkPayload(usage),
            }),
          );
        }

        if (sawError) {
          // Best-effort: surface the error as a final content delta since
          // the SSE stream has already started (headers are committed, so a
          // proper error *response* is no longer possible).
          safeEnqueue(
            sseFrame({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: `\n\n[error: ${sawError}]` }, finish_reason: "stop" }],
            }),
          );
        } else {
          safeEnqueue(
            sseFrame({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          );
        }
        safeEnqueue(SSE_DONE);
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // already closed/cancelled concurrently
          }
        }
      } catch (err) {
        if (!cancelled) {
          try {
            controller.error(err);
          } catch {
            // already closed/cancelled concurrently
          }
        }
      } finally {
        settle();
      }
    },
    cancel() {
      // Fires when the client disconnects mid-stream. Kill immediately: an
      // abandoned Turn must not keep burning tokens to completion, and the
      // process must not become an orphan.
      cancelled = true;
      proc.kill();
      settle();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
