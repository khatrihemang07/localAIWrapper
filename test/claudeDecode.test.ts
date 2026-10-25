import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createClaudeLineDecoder } from "../src/backends/claude.ts";
import type { DecodedLine } from "../src/backends/index.ts";

// Event shapes below follow a live `claude -p --output-format stream-json
// --verbose --include-partial-messages` run with claude-haiku (see
// docs/adr/0007 and the probe notes in the PR): each assistant message opens
// with message_start, a tool round is a tool_use content block followed by a
// user (tool_result) line, and the next message opens with its own
// message_start.

const ev = (event: unknown) => JSON.stringify({ type: "stream_event", event });
const messageStart = (id: string) => ev({ type: "message_start", message: { id } });
const blockStart = (block: unknown) => ev({ type: "content_block_start", index: 0, content_block: block });
const textDelta = (text: string) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const blockStop = () => ev({ type: "content_block_stop", index: 0 });
const toolResult = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } });

function textsOf(lines: string[]): string[] {
  const decode = createClaudeLineDecoder();
  const out: string[] = [];
  for (const line of lines) {
    const d: DecodedLine | null = decode(line);
    if (d?.text !== undefined) out.push(d.text);
  }
  return out;
}

test("text from a message after a tool_use is separated from the text before it", () => {
  const texts = textsOf([
    messageStart("m1"),
    blockStart({ type: "text", text: "" }),
    textDelta("Let me read the file."),
    blockStop(),
    blockStart({ type: "tool_use", id: "t1", name: "Read", input: {} }),
    blockStop(),
    toolResult,
    messageStart("m2"),
    blockStart({ type: "text", text: "" }),
    textDelta("The answer is X."),
    blockStop(),
  ]);
  expect(texts).toEqual(["Let me read the file.", "\n\nThe answer is X."]);
  expect(texts.join("")).toBe("Let me read the file.\n\nThe answer is X.");
});

test("no separator is inserted before the first text of the Turn", () => {
  const texts = textsOf([
    messageStart("m1"),
    blockStart({ type: "tool_use", id: "t1", name: "Read", input: {} }),
    blockStop(),
    toolResult,
    messageStart("m2"),
    blockStart({ type: "text", text: "" }),
    textDelta("The answer is X."),
  ]);
  expect(texts).toEqual(["The answer is X."]);
});

test("every delta is still streamed, one per event, and a single message gets no separator", () => {
  const texts = textsOf([
    messageStart("m1"),
    blockStart({ type: "text", text: "" }),
    textDelta("One"),
    textDelta(" two"),
    textDelta(" three"),
    blockStop(),
  ]);
  expect(texts).toEqual(["One", " two", " three"]);
});

test("a later message with no tool_use in between is not separated", () => {
  const texts = textsOf([
    messageStart("m1"),
    blockStart({ type: "text", text: "" }),
    textDelta("Hello"),
    blockStop(),
    messageStart("m2"),
    blockStart({ type: "text", text: "" }),
    textDelta("World"),
  ]);
  expect(texts).toEqual(["Hello", "World"]);
});

test("two separate Turns do not share separator state", () => {
  const first = createClaudeLineDecoder();
  first(messageStart("m1"));
  first(blockStart({ type: "text", text: "" }));
  first(textDelta("A"));
  first(blockStart({ type: "tool_use", id: "t", name: "Read", input: {} }));
  first(messageStart("m2"));

  const second = createClaudeLineDecoder();
  second(messageStart("x1"));
  second(blockStart({ type: "text", text: "" }));
  expect(second(textDelta("B"))?.text).toBe("B");
});

// ---- structured output (item 4) --------------------------------------------

const schemaOk = (text: string) => {
  const o = JSON.parse(text);
  return Object.keys(o).sort().join(",") === "color,n" && typeof o.color === "string" && Number.isInteger(o.n);
};

test("the final line's answer is structured_output when the CLI reports it", () => {
  const line = readFileSync(new URL("./fixtures/claude-structured-final-line.jsonl", import.meta.url), "utf8").trim();
  const d = createClaudeLineDecoder()(line);
  expect(d?.final).toBe(true);
  expect(d?.text).toBe('{"color":"blue","n":7}');
  expect(schemaOk(d!.text!)).toBe(true);
});

test("structured_output wins over a prose result on the same final line", () => {
  const obj = JSON.parse(readFileSync(new URL("./fixtures/claude-structured-final-line.jsonl", import.meta.url), "utf8"));
  obj.result = "Here is the pair you asked for.";
  obj.structured_output = { color: "green", n: 3 };
  const d = createClaudeLineDecoder()(JSON.stringify(obj));
  expect(d?.text).toBe('{"color":"green","n":3}');
});

test("without structured_output the final line still carries result", () => {
  const obj = { type: "result", subtype: "success", is_error: false, result: "pong", usage: { input_tokens: 1, output_tokens: 1 } };
  const d = createClaudeLineDecoder()(JSON.stringify(obj));
  expect(d?.text).toBe("pong");
  expect(d?.final).toBe(true);
});
