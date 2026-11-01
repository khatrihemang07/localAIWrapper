// Turns a Turn's decoded events into the HTTP response: one JSON envelope for a
// buffered request, or an SSE stream for a streaming one. Takes a TurnRun, so
// it can be tested with a fake run and no CLI process.

import type { TurnRun, Usage } from "./backends/index.ts";
import { type ChatCompletionResponse, completionId, errorResponse, sseFrame, SSE_DONE } from "./openai.ts";
import type { ToolCall } from "./toolEmulation.ts";

export type AbortReason = "client_disconnected" | "timeout";

/** Everything a response needs to know about the Turn it is reporting on. */
export type ResponseContext = {
  model: string;
  timeoutMs: number;
  getAbortReason: () => AbortReason | undefined;
  log: (msg: string) => void;
  requestStartedAt: number;
};

// Appends a Backend's diagnostic context (the CLI's stderr tail) to a message.
function withDetail(message: string, detail: string): string {
  return detail ? `${message} (stderr: ${detail})` : message;
}

function usageChunkPayload(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens ?? 0,
    completion_tokens: usage.completionTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
  };
}

function describeReadFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Backend output could not be read: ${message}`;
}

/** Turns a finished reply's text into message content and tool calls (tool emulation). */
export type ReplyParser = (text: string) => { content: string | null; toolCalls: ToolCall[] };

export async function bufferedResponse(run: TurnRun, ctx: ResponseContext, parseReply?: ReplyParser): Promise<Response> {
  let text = "";
  let usage: Usage | undefined;
  let error: string | undefined;

  try {
    for await (const decoded of run.events) {
      if (typeof decoded.text === "string") text = decoded.text;
      if (decoded.usage) usage = decoded.usage;
      if (decoded.error) error = decoded.error;
    }
  } catch (err) {
    // The stream broke before the Turn ended: stop the process, then fall
    // through to the normal finish and error path.
    run.kill();
    error = describeReadFailure(err);
  }

  // Always awaited, so the process is reaped and any per-Turn temp files are
  // removed before the caller releases its concurrency slot.
  const outcome = await run.finish();
  const elapsedMs = Date.now() - ctx.requestStartedAt;

  if (ctx.getAbortReason() === "timeout") {
    ctx.log(`timed out after ${elapsedMs}ms, turn terminated`);
    return errorResponse(
      `Turn exceeded the configured timeout (${ctx.timeoutMs}ms) and was terminated`,
      504,
      "timeout_error",
    );
  }

  if (error) {
    ctx.log(`backend reported an error after ${elapsedMs}ms: ${error}`);
    return errorResponse(withDetail(error, outcome.detail), 502, "backend_error");
  }
  if (outcome.failure) {
    ctx.log(`${outcome.failure} after ${elapsedMs}ms`);
    return errorResponse(outcome.detail || outcome.failure, 502, "backend_error");
  }

  ctx.log(`completed in ${elapsedMs}ms`);
  const reply = parseReply ? parseReply(text) : { content: text, toolCalls: [] as ToolCall[] };
  const called = reply.toolCalls.length > 0;
  const response: ChatCompletionResponse = {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ctx.model,
    choices: [
      {
        index: 0,
        message: called
          ? { role: "assistant", content: reply.content, tool_calls: reply.toolCalls }
          : { role: "assistant", content: reply.content ?? "" },
        finish_reason: called ? "tool_calls" : "stop",
      },
    ],
  };
  if (usage) {
    response.usage = usageChunkPayload(usage);
  }
  return Response.json(response);
}

export function streamResponse(run: TurnRun, ctx: ResponseContext, onSettled: () => void): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const model = ctx.model;
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
      let sentText = false;
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

      const emitText = (text: string) => {
        const delta: { role?: "assistant"; content?: string } = { content: text };
        if (!sentRole) {
          delta.role = "assistant";
          sentRole = true;
        }
        sentText = true;
        safeEnqueue(
          sseFrame({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: null }],
          }),
        );
      };

      try {
        try {
          for await (const decoded of run.events) {
            if (decoded.error) {
              sawError = decoded.error;
              if (decoded.usage) usage = decoded.usage;
              break;
            }
            // Stop on the explicit terminal marker, never on "usage is
            // present" — see the `final` doc comment on DecodedLine.
            if (decoded.final) {
              if (decoded.usage) usage = decoded.usage;
              // The terminal line also carries the whole answer as `text`. Send
              // it only when no delta carried any: otherwise it repeats them.
              // Structured output on claude can arrive with no deltas at all.
              if (decoded.text && !sentText) emitText(decoded.text);
              break;
            }
            if (decoded.text) emitText(decoded.text);
          }
        } catch (err) {
          // The stream broke before the Turn ended. Stop the process; the
          // error frame below reports it, and finish() still runs.
          run.kill();
          sawError = describeReadFailure(err);
        }

        const outcome = await run.finish();
        const elapsedMs = Date.now() - ctx.requestStartedAt;

        const abortReason = ctx.getAbortReason();
        if (!sawError && abortReason === "timeout") {
          sawError = `Turn exceeded the configured timeout (${ctx.timeoutMs}ms) and was terminated`;
        } else if (!sawError && outcome.failure && abortReason !== "client_disconnected") {
          sawError = withDetail(outcome.failure, outcome.detail);
        }

        if (cancelled) {
          ctx.log(`client disconnected mid-stream after ${elapsedMs}ms`);
          // Client already gone: nothing left to emit.
          return;
        }

        ctx.log(sawError ? `stream ended with an error after ${elapsedMs}ms: ${sawError}` : `stream completed in ${elapsedMs}ms`);

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
      run.kill();
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

/**
 * Re-frames a finished buffered completion as an SSE stream, for a streaming
 * client whose reply had to be read whole first (tool emulation must see the
 * full text to know whether it is a tool call). Error responses pass through
 * untouched: headers were never committed, so a real status is still possible.
 */
export async function bufferedToSse(buffered: Response): Promise<Response> {
  if (!buffered.ok) return buffered;
  const full = (await buffered.json()) as ChatCompletionResponse;
  const choice = full.choices[0];
  const base = { id: full.id, object: "chat.completion.chunk" as const, created: full.created, model: full.model };
  const frames: string[] = [];
  if (choice.message.tool_calls?.length) {
    const delta: { role: "assistant"; content?: string; tool_calls: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }> } = {
      role: "assistant",
      tool_calls: choice.message.tool_calls.map((c, index) => ({ index, ...c })),
    };
    if (choice.message.content) delta.content = choice.message.content;
    frames.push(sseFrame({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }));
  } else {
    frames.push(sseFrame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: choice.message.content ?? "" }, finish_reason: null }] }));
  }
  if (full.usage) frames.push(sseFrame({ ...base, choices: [], usage: full.usage }));
  frames.push(sseFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] }));
  frames.push(SSE_DONE);
  return new Response(frames.join(""), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
