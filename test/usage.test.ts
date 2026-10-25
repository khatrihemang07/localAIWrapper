import { expect, test } from "bun:test";
import { toUsage } from "../src/backends/cli.ts";

// Both CLIs report usage as input_tokens/output_tokens; the mapping is shared.

test("maps input and output tokens and totals them", () => {
  expect(toUsage({ input_tokens: 12, output_tokens: 5 })).toEqual({
    promptTokens: 12,
    completionTokens: 5,
    totalTokens: 17,
  });
});

test("a missing field counts as zero in the total", () => {
  expect(toUsage({ output_tokens: 5 })).toEqual({ promptTokens: undefined, completionTokens: 5, totalTokens: 5 });
});

test("no usage object means no usage", () => {
  expect(toUsage(undefined)).toBeUndefined();
  expect(toUsage(null)).toBeUndefined();
});
