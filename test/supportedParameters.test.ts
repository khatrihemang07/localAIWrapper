import { expect, test } from "bun:test";
import { listOpenAIModels } from "../src/discovery.ts";

test("every Model's supported_parameters follows its reasoning_effort option", () => {
  const { data } = listOpenAIModels();
  expect(data.length).toBeGreaterThan(0);
  for (const m of data) {
    const supported = m.local_ai_wrapper.options.reasoning_effort?.supported === true;
    expect(m.supported_parameters).toEqual(supported ? ["reasoning_effort"] : []);
  }
});
