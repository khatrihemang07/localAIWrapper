import { expect, test } from "bun:test";
import { checkMessages } from "../src/openai.ts";

test("a system-only message list is rejected with a message", () => {
  expect(checkMessages([{ role: "system", content: "You are terse." }])).toBeTypeOf("string");
});

test("a list with a user message is accepted", () => {
  expect(checkMessages([{ role: "system", content: "s" }, { role: "user", content: "hi" }])).toBeUndefined();
});

test("a list with only an assistant message is accepted", () => {
  expect(checkMessages([{ role: "assistant", content: "hi" }])).toBeUndefined();
});
