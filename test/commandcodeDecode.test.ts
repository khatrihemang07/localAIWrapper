import { expect, test } from "bun:test";
import { decodeLine } from "../src/backends/commandcode.ts";
import type { DecodedLine } from "../src/backends/index.ts";

// Fixtures are real output of `commandcode -p --output-format json` (v1.88.0).
// The stream fixture is one tiny prompt; the write-blocked fixture is a run in
// which the model tried a write and the CLI refused it.

async function decodeFixture(name: string): Promise<DecodedLine[]> {
  const raw = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
  return raw
    .split("\n")
    .map((l) => decodeLine(l))
    .filter((d): d is DecodedLine => d !== null);
}

test("text_delta events carry the streamed text, in order", async () => {
  const decoded = await decodeFixture("commandcode-stream.jsonl");
  const deltas = decoded.filter((d) => d.text !== undefined && !d.final).map((d) => d.text);
  expect(deltas).toEqual(["PONG"]);
});

test("the final result line ends the Turn with the whole answer and camelCase usage mapped", async () => {
  const decoded = await decodeFixture("commandcode-stream.jsonl");
  const last = decoded[decoded.length - 1];
  expect(last).toEqual({
    text: "PONG",
    usage: { promptTokens: 13948, completionTokens: 3, totalTokens: 13951 },
    final: true,
  });
});

test("a run whose write was blocked decodes to its final answer, with no error and no tool events", async () => {
  const decoded = await decodeFixture("commandcode-write-blocked.jsonl");
  expect(decoded.some((d) => d.error !== undefined)).toBe(false);
  expect(decoded.filter((d) => d.final)).toHaveLength(1);
  const last = decoded[decoded.length - 1];
  expect(last?.final).toBe(true);
  expect(last?.text).toMatch(/write was blocked/);
  expect(last?.usage?.completionTokens).toBe(167);
});

test("a non-success result line is an error ending the Turn; its finalText is the message", () => {
  // Synthetic: no failing run has been captured yet, so the failure shape is
  // assumed to mirror the success line. See docs/adr/0008.
  const d = decodeLine(JSON.stringify({ type: "result", subtype: "error", finalText: "quota exceeded" }));
  expect(d).toEqual({ error: "quota exceeded", usage: undefined, final: true });
});

test("a non-success result line with no message gets a generic error", () => {
  const d = decodeLine(JSON.stringify({ type: "result", subtype: "error" }));
  expect(d?.error).toBe("commandcode reported an error");
  expect(d?.final).toBe(true);
});

test("lines that are not JSON, or are other events, decode to nothing", () => {
  expect(decodeLine("Reasoning effort set to high for DeepSeek V4 Flash (latest).")).toBeNull();
  expect(decodeLine("")).toBeNull();
  expect(decodeLine(JSON.stringify({ type: "event", event: { type: "message_start" } }))).toBeNull();
});
