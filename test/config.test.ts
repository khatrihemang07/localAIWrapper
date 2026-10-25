import { expect, test } from "bun:test";
import { validateModels } from "../src/config.ts";

// A valid Model whose options are all declared as unsupported at their neutral
// defaults. Each test then breaks exactly one thing.
function bareModel(overrides: Record<string, unknown> = {}) {
  return {
    backend: "claude",
    model: "haiku",
    options: {
      reasoning_effort: { supported: false, values: null, default: null, description: "x" },
      web: { supported: false, values: [false], default: false, description: "x" },
      access: { supported: false, values: ["none"], default: "none", description: "x" },
      workdir: { supported: false, values: null, default: null, description: "x" },
      ...overrides,
    },
  };
}

test("a Model whose unsupported options sit at their neutral defaults boots", () => {
  expect(() => validateModels({ ok: bareModel() })).not.toThrow();
});

test("an unsupported access with a non-neutral default fails the boot", () => {
  const m = bareModel({ access: { supported: false, values: ["read-only"], default: "read-only", description: "x" } });
  expect(() => validateModels({ m })).toThrow(/access/);
});

test("an unsupported web with a non-neutral default fails the boot", () => {
  const m = bareModel({ web: { supported: false, values: [false, true], default: true, description: "x" } });
  expect(() => validateModels({ m })).toThrow(/web/);
});

test("a non-null workdir default fails the boot, even when workdir is supported", () => {
  const m = bareModel({ workdir: { supported: true, values: null, default: "/tmp", description: "x" } });
  expect(() => validateModels({ m })).toThrow(/workdir/);
});

test("an unsupported reasoning_effort with a non-null default fails the boot", () => {
  const m = bareModel({ reasoning_effort: { supported: false, values: ["low"], default: "low", description: "x" } });
  expect(() => validateModels({ m })).toThrow(/reasoning_effort/);
});

// ---- codex access values (docs/adr/0007) -------------------------------------

test("a codex Model's access offers read-only (default) and workspace-write, never none", () => {
  const cfg = validateModels({ c: { backend: "codex", model: "gpt-x" } });
  expect(cfg.c.options.access.values).toEqual(["read-only", "workspace-write"]);
  expect(cfg.c.options.access.default).toBe("read-only");
});

test("a codex access description says read-only can still read outside the workdir", () => {
  const cfg = validateModels({ c: { backend: "codex", model: "gpt-x" } });
  expect(cfg.c.options.access.description).toMatch(/read-only/);
  expect(cfg.c.options.access.description).toMatch(/read.*outside.*workdir/i);
});

test("a claude Model keeps none (default), read-only and workspace-write", () => {
  const cfg = validateModels({ c: { backend: "claude", model: "haiku" } });
  expect(cfg.c.options.access.values).toEqual(["none", "read-only", "workspace-write"]);
  expect(cfg.c.options.access.default).toBe("none");
});

// ---- boot checks on models.json (item 6) ------------------------------------

test("an unknown backend name is reported as such, before anything else is checked", () => {
  // The Model also has a bogus key and a bad option; the backend must win.
  const m = { backend: "gemini", model: "x", args: ["--y"], options: "nope" };
  expect(() => validateModels({ m })).toThrow(/names unknown backend "gemini"/);
});

test("a Model with a backend name that is not a string is rejected as a missing backend", () => {
  expect(() => validateModels({ m: { backend: 3, model: "x" } })).toThrow(/backend/);
});

test("an unknown key on a Model entry fails the boot and names the key", () => {
  expect(() => validateModels({ m: { backend: "claude", model: "haiku", args: ["-x"] } })).toThrow(/unknown key "args"/);
  expect(() => validateModels({ m: { backend: "codex", model: "gpt", transport: "sdk" } })).toThrow(/unknown key "transport"/);
});

test("an unknown key on an option spec fails the boot and names the key", () => {
  const m = {
    backend: "claude",
    model: "haiku",
    options: { access: { supported: true, values: ["none"], default: "none", description: "x", args: ["--y"] } },
  };
  expect(() => validateModels({ m })).toThrow(/option "access".*unknown key "args"/);
  const t = {
    backend: "claude",
    model: "haiku",
    options: { web: { supported: false, values: [false], default: false, description: "x", transport: "sdk" } },
  };
  expect(() => validateModels({ t })).toThrow(/unknown key "transport"/);
});

test("an unknown option name fails the boot and names it", () => {
  const m = { backend: "claude", model: "haiku", options: { temperature: { supported: false, values: null, default: null, description: "x" } } };
  expect(() => validateModels({ m })).toThrow(/unknown option "temperature"/);
});

test("a supported option with no values array fails the boot (workdir is the only free-form option)", () => {
  const m = { backend: "claude", model: "haiku", options: { access: { supported: true, values: null, default: null, description: "x" } } };
  expect(() => validateModels({ m })).toThrow(/access.*"values"/);
  const e = { backend: "claude", model: "haiku", options: { reasoning_effort: { supported: true, values: [], default: null, description: "x" } } };
  expect(() => validateModels({ e })).toThrow(/reasoning_effort.*"values"/);
});

test("a supported workdir with null values is still valid", () => {
  expect(() => validateModels({ w: { backend: "claude", model: "haiku" } })).not.toThrow();
});
