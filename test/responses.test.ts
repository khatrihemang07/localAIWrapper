import { expect, test } from "bun:test";
import { bufferedResponse, streamResponse, type ResponseContext } from "../src/responses.ts";
import type { DecodedLine, TurnOutcome, TurnRun } from "../src/backends/index.ts";

// A fake TurnRun: yields the given lines, optionally throws after them, and
// records kill/finish calls in order so tests can assert the cleanup sequence.
function fakeRun(lines: DecodedLine[], opts: { throwAfter?: boolean; outcome?: TurnOutcome } = {}) {
  const calls: string[] = [];
  async function* events(): AsyncGenerator<DecodedLine> {
    for (const line of lines) yield line;
    if (opts.throwAfter) throw new Error("pipe exploded");
  }
  const run: TurnRun = {
    events: events(),
    kill() {
      calls.push("kill");
    },
    async finish() {
      calls.push("finish");
      return opts.outcome ?? { detail: "" };
    },
  };
  return { run, calls };
}

const ctx: ResponseContext = {
  model: "claude-haiku",
  timeoutMs: 60_000,
  getAbortReason: () => undefined,
  log: () => {},
  requestStartedAt: Date.now(),
};

// Concatenated assistant content of an SSE body, ignoring usage/finish frames.
async function streamedContent(res: Response): Promise<string> {
  const raw = await res.text();
  return raw
    .split("\n\n")
    .filter((b) => b.startsWith("data:"))
    .map((b) => b.slice(5).trim())
    .filter((p) => p !== "[DONE]")
    .map((p) => JSON.parse(p))
    .flatMap((o) => o.choices ?? [])
    .map((c: { delta?: { content?: string } }) => c.delta?.content ?? "")
    .join("");
}

// ---- item 4: a throwing event iterator still kills and finishes the run ------

test("buffered: a throwing event stream kills and finishes the run, then returns a 502 envelope", async () => {
  const { run, calls } = fakeRun([{ text: "partial" }], { throwAfter: true });
  const res = await bufferedResponse(run, ctx);
  expect(calls).toEqual(["kill", "finish"]);
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: { message: string; type: string } };
  expect(body.error.type).toBe("backend_error");
  expect(body.error.message).toContain("pipe exploded");
});

test("streaming: a throwing event stream kills and finishes the run and ends the stream with an error frame", async () => {
  const { run, calls } = fakeRun([{ text: "partial" }], { throwAfter: true });
  const res = streamResponse(run, ctx, () => {});
  const content = await streamedContent(res);
  expect(calls).toEqual(["kill", "finish"]);
  expect(content).toContain("[error: ");
  expect(content).toContain("pipe exploded");
});

test("buffered: a clean run does not kill, and finishes once", async () => {
  const { run, calls } = fakeRun([{ text: "hi", final: true, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }]);
  const res = await bufferedResponse(run, ctx);
  expect(calls).toEqual(["finish"]);
  expect(res.status).toBe(200);
});

// ---- item 3: the final line's text is sent when no delta carried it ----------

test("streaming: a final line with text and no prior deltas is sent as content", async () => {
  // Structured output on claude can arrive with no text deltas at all; the
  // whole answer is only on the terminal `result` line.
  const json = '{"color":"teal","n":3}';
  const { run } = fakeRun([{ text: json, final: true }]);
  const content = await streamedContent(streamResponse(run, ctx, () => {}));
  expect(content).toBe(json);
});

test("streaming: a final line repeating the streamed deltas is not sent twice", async () => {
  const { run } = fakeRun([{ text: "Hel" }, { text: "lo" }, { text: "Hello", final: true }]);
  const content = await streamedContent(streamResponse(run, ctx, () => {}));
  expect(content).toBe("Hello");
});

test("streaming: deltas followed by a final line with no text still deliver the deltas", async () => {
  const { run } = fakeRun([{ text: "Hel" }, { text: "lo" }, { final: true }]);
  const content = await streamedContent(streamResponse(run, ctx, () => {}));
  expect(content).toBe("Hello");
});
