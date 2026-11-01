import { expect, test } from "bun:test";
import { parseToolReply, prepareToolEmulation } from "../src/toolEmulation.ts";
import { bufferedResponse, bufferedToSse } from "../src/responses.ts";
import type { TurnRun } from "../src/backends/index.ts";

const tools = [
  { type: "function", function: { name: "mastery_status", description: "status", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "ask_user", parameters: { type: "object", properties: { q: { type: "string" } } } } },
];
const names = new Set(["mastery_status", "ask_user"]);

test("a tool_call block becomes a tool call and drops text after it", () => {
  const r = parseToolReply('Checking.\n<tool_call>{"name":"ask_user","arguments":{"q":"hi"}}</tool_call>\n<tool_result>fake</tool_result>', names);
  expect(r.content).toBe("Checking.");
  expect(r.toolCalls).toHaveLength(1);
  expect(r.toolCalls[0]!.function.name).toBe("ask_user");
  expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ q: "hi" });
  expect(r.toolCalls[0]!.id).toMatch(/^call_/);
});

test("several blocks give parallel calls; fenced JSON is accepted", () => {
  const r = parseToolReply(
    '<tool_call>```json\n{"name":"mastery_status","arguments":{}}\n```</tool_call><tool_call>{"name":"ask_user","parameters":{"q":"x"}}</tool_call>',
    names,
  );
  expect(r.content).toBeNull();
  expect(r.toolCalls.map((c) => c.function.name)).toEqual(["mastery_status", "ask_user"]);
});

test("unknown tool, bad JSON and non-object arguments are not calls", () => {
  for (const block of [
    '{"name":"rm_rf","arguments":{}}',
    "{not json",
    '{"name":"ask_user","arguments":"str"}',
    '{"name":"ask_user","arguments":[1]}',
  ]) {
    const r = parseToolReply(`<tool_call>${block}</tool_call>`, names);
    expect(r.toolCalls).toHaveLength(0);
  }
});

test("plain prose passes through unchanged", () => {
  expect(parseToolReply("Just an answer.", names)).toEqual({ content: "Just an answer.", toolCalls: [] });
});

test("prepare flattens assistant tool_calls and tool results to text", () => {
  const p = prepareToolEmulation({
    tools,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ask_user", arguments: '{"q":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "answer" },
    ],
  });
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.value.messages[2]).toEqual({ role: "assistant", content: '<tool_call>{"name":"ask_user","arguments":{"q":"a"}}</tool_call>' });
  expect(p.value.messages[3]!.role).toBe("user");
  expect(p.value.messages[3]!.content).toContain('<tool_result name="ask_user" id="c1">');
  expect(p.value.instructions).toContain("mastery_status");
  expect([...p.value.toolNames]).toEqual(["mastery_status", "ask_user"]);
});

test("tool_choice none offers no tools; a named choice narrows them; unknown name is an error", () => {
  const msgs = [{ role: "user", content: "x" }];
  const none = prepareToolEmulation({ tools, tool_choice: "none", messages: msgs });
  expect(none.ok && none.value.toolNames.size).toBe(0);
  const one = prepareToolEmulation({ tools, tool_choice: { type: "function", function: { name: "ask_user" } }, messages: msgs });
  expect(one.ok && [...one.value.toolNames]).toEqual(["ask_user"]);
  expect(prepareToolEmulation({ tools, tool_choice: { type: "function", function: { name: "nope" } }, messages: msgs }).ok).toBe(false);
});

test("malformed tools are rejected", () => {
  expect(prepareToolEmulation({ tools: [{ type: "x" }], messages: [{ role: "user", content: "x" }] }).ok).toBe(false);
});

function fakeRun(text: string): TurnRun {
  return {
    events: (async function* () {
      yield { text, final: true, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
    })(),
    kill() {},
    async finish() {
      return { detail: "" };
    },
  } as unknown as TurnRun;
}
const ctx = { model: "m", timeoutMs: 1000, getAbortReason: () => undefined, log() {}, requestStartedAt: Date.now() };

test("buffered response carries tool_calls and finish_reason tool_calls", async () => {
  const res = await bufferedResponse(fakeRun('<tool_call>{"name":"ask_user","arguments":{}}</tool_call>'), ctx, (t) => parseToolReply(t, names));
  const body = (await res.json()) as any;
  expect(body.choices[0].finish_reason).toBe("tool_calls");
  expect(body.choices[0].message.tool_calls[0].function.name).toBe("ask_user");
  expect(body.choices[0].message.content).toBeNull();
});

test("streaming re-frame emits tool_calls delta, usage, finish and DONE", async () => {
  const buffered = await bufferedResponse(fakeRun('<tool_call>{"name":"ask_user","arguments":{"q":"z"}}</tool_call>'), ctx, (t) => parseToolReply(t, names));
  const sse = await (await bufferedToSse(buffered)).text();
  expect(sse).toContain('"tool_calls":[{"index":0');
  expect(sse).toContain('"finish_reason":"tool_calls"');
  expect(sse).toContain('"usage"');
  expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true);
});

test("streaming re-frame of plain text emits content", async () => {
  const buffered = await bufferedResponse(fakeRun("hello"), ctx, (t) => parseToolReply(t, names));
  const sse = await (await bufferedToSse(buffered)).text();
  expect(sse).toContain('"content":"hello"');
  expect(sse).toContain('"finish_reason":"stop"');
});

test("tool history without a tools list is still flattened, with nothing offered", () => {
  const p = prepareToolEmulation({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "done" },
    ],
  });
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.value.toolNames.size).toBe(0);
  expect(p.value.instructions).toContain("No tools are available");
  expect(p.value.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(p.value.messages[1]!.content).toContain("<tool_call>");
});

test("a developer message is treated as a system message", () => {
  const p = prepareToolEmulation({
    tools,
    messages: [
      { role: "developer", content: "dev rules" },
      { role: "user", content: "go" },
    ],
  });
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  expect(p.value.messages[0]).toEqual({ role: "system", content: "dev rules" });
});
