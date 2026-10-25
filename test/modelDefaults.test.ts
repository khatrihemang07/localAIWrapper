import { expect, test } from "bun:test";
import golden from "./fixtures/models-listing.json";
import { validateModels } from "../src/config.ts";
import { listOpenAIModels } from "../src/discovery.ts";

// `created` is stamped at process start, so it is excluded from comparisons.
const withoutCreated = (listing: { data: Array<Record<string, unknown>> }) => ({
  ...listing,
  data: listing.data.map(({ created: _c, ...rest }) => rest),
});

test("/v1/models output is unchanged by moving the shared options into config", () => {
  expect(withoutCreated(listOpenAIModels())).toEqual(withoutCreated(golden as never));
});

test("a Model that omits options gets its backend's defaults", () => {
  const cfg = validateModels({ bare: { backend: "codex", model: "gpt-x" } });
  expect(cfg.bare.options).toEqual(validateModels({ full: { backend: "codex", model: "gpt-x", options: {} } }).full.options);
  expect(cfg.bare.options.access.default).toBe("read-only");
  expect(cfg.bare.options.web.default).toBe(false);
});

test("a Model's own option replaces only that option; the rest come from its backend", () => {
  const cfg = validateModels({
    m: {
      backend: "claude",
      model: "haiku",
      options: { access: { supported: false, values: ["none"], default: "none", description: "off" } },
    },
  });
  expect(cfg.m.options.access.supported).toBe(false);
  expect(cfg.m.options.web.supported).toBe(true);
  expect(cfg.m.options.workdir.supported).toBe(true);
});

test("a Model with a non-object options value still fails the boot", () => {
  expect(() => validateModels({ m: { backend: "claude", model: "haiku", options: "nope" } })).toThrow(/options/);
});
