import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarnesses, parseHarnesses, validateHarnesses, validateModels } from "../src/config.ts";
import { resolveFromCatalog } from "../src/backends/commandcode.ts";

const base = validateModels({
  "claude-sonnet": { backend: "claude", model: "sonnet", systemPrompt: "Be brief.", contextWindow: 200000 },
  "claude-haiku": { backend: "claude", model: "haiku" },
  "codex-luna": {
    backend: "codex",
    model: "gpt-5.6-luna",
    options: { web: { supported: false, values: [false], default: false, description: "off" } },
  },
});

const TOKEN = { CLAUDE_CODE_OAUTH_TOKEN: { file: "~/.config/claude/oauth_token_a" } };

test("a claude harness expands every claude Model as <harness>-<suffix> with env, same options and fields", () => {
  const out = validateHarnesses({ aclaude: { adapter: "claude", env: TOKEN } }, base);
  expect(Object.keys(out).sort()).toEqual(["aclaude-haiku", "aclaude-sonnet"]);
  const s = out["aclaude-sonnet"]!;
  expect(s.backend).toBe("claude");
  expect(s.model).toBe("sonnet");
  expect(s.systemPrompt).toBe("Be brief.");
  expect(s.contextWindow).toBe(200000);
  expect(s.options).toEqual(base["claude-sonnet"]!.options);
  expect(s.env).toEqual(TOKEN);
  expect(s.harness).toBe("aclaude");
  expect(s.bin).toBeUndefined();
});

test("a codex harness expands codex Models and carries bin and plain-text env", () => {
  const out = validateHarnesses({ xcodex: { adapter: "codex", bin: "/opt/codex", env: { CODEX_HOME: "/tmp/h" } } }, base);
  expect(Object.keys(out)).toEqual(["xcodex-luna"]);
  expect(out["xcodex-luna"]!.bin).toBe("/opt/codex");
  expect(out["xcodex-luna"]!.env).toEqual({ CODEX_HOME: "/tmp/h" });
  expect(out["xcodex-luna"]!.options.web.supported).toBe(false);
});

test("a commandcode harness expands nothing from models.json but is recorded for pass-through", () => {
  const raw = { cc2: { adapter: "commandcode", env: { COMMAND_CODE_API_KEY: { file: "/k" } } } };
  expect(validateHarnesses(raw, base)).toEqual({});
  expect(parseHarnesses(raw, base).cc2!.adapter).toBe("commandcode");
});

test("env is optional", () => {
  const out = validateHarnesses({ plain: { adapter: "claude" } }, base);
  expect(out["plain-haiku"]!.env).toEqual({});
});

test("an expanded name that collides with a models.json name fails the boot, naming the harness", () => {
  // harness "claude" would produce "claude-sonnet", already in models.json
  expect(() => validateHarnesses({ claude: { adapter: "claude" } }, base)).toThrow(/harness "claude".*claude-sonnet/);
});

test("two harnesses producing the same expanded name fail the boot", () => {
  // "a" + "-b-x" and "a-b" + "-x" are both "a-b-x"
  const two = validateModels({ "claude-b-x": { backend: "claude", model: "x" }, "claude-x": { backend: "claude", model: "y" } });
  expect(() => validateHarnesses({ a: { adapter: "claude" }, "a-b": { adapter: "claude" } }, two)).toThrow(/harness "a-b".*a-b-x/);
});

test("an unknown adapter fails the boot, naming the harness", () => {
  expect(() => validateHarnesses({ h: { adapter: "gemini" } }, base)).toThrow(/harness "h".*adapter.*gemini/);
  expect(() => validateHarnesses({ h: {} }, base)).toThrow(/harness "h".*adapter/);
});

test("an unknown key fails the boot, naming the harness and key", () => {
  expect(() => validateHarnesses({ h: { adapter: "claude", token: "x" } }, base)).toThrow(/harness "h".*unknown key "token"/);
});

test("a bad env shape fails the boot, naming the harness and variable, without printing the value", () => {
  const secret = "s3cret-value";
  const cases: unknown[] = [
    { V: 5 },
    { V: true },
    { V: null },
    { V: [secret] },
    { V: { file: 7 } },
    { V: { file: "" } },
    { V: { file: "/p", extra: secret } },
    { V: { path: secret } },
    [secret],
    secret,
  ];
  for (const env of cases) {
    let message = "";
    try {
      validateHarnesses({ h: { adapter: "claude", env } }, base);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/harness "h"/);
    expect(message).not.toContain(secret);
  }
  expect(() => validateHarnesses({ h: { adapter: "claude", env: { "BAD NAME": "x" } } }, base)).toThrow(/harness "h".*BAD NAME/);
});

test("a bad bin fails the boot", () => {
  expect(() => validateHarnesses({ h: { adapter: "claude", bin: 3 } }, base)).toThrow(/harness "h".*bin/);
  expect(() => validateHarnesses({ h: { adapter: "claude", bin: "" } }, base)).toThrow(/harness "h".*bin/);
});

test("a harness name that cannot be a model-name prefix fails the boot", () => {
  expect(() => validateHarnesses({ "a/b": { adapter: "claude" } }, base)).toThrow(/harness "a\/b"/);
  expect(() => validateHarnesses({ commandcode: { adapter: "claude" } }, base)).toThrow(/harness "commandcode"/);
});

test("harnesses must be an object of objects", () => {
  expect(() => validateHarnesses([], base)).toThrow(/harnesses/);
  expect(() => validateHarnesses({ h: "claude" }, base)).toThrow(/harness "h"/);
});

// ---- loadHarnesses: the optional file ----------------------------------------

const dir = mkdtempSync(join(tmpdir(), "harnesses-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a missing config.yaml means no harnesses and no Models added", () => {
  const out = loadHarnesses(join(dir, "nope.yaml"), base);
  expect(out.harnesses).toEqual({});
  expect(out.models).toEqual({});
});

test("an empty config.yaml means no harnesses", () => {
  const p = join(dir, "empty.yaml");
  writeFileSync(p, "# nothing\n");
  expect(loadHarnesses(p, base).models).toEqual({});
});

test("a config.yaml is parsed as YAML and expanded", () => {
  const p = join(dir, "ok.yaml");
  writeFileSync(
    p,
    [
      "harnesses:",
      "  aclaude:",
      "    adapter: claude",
      "    env: {CLAUDE_CODE_OAUTH_TOKEN: {file: ~/.config/claude/oauth_token_a}, PLAIN: text}",
      "",
    ].join("\n"),
  );
  const out = loadHarnesses(p, base);
  expect(Object.keys(out.models).sort()).toEqual(["aclaude-haiku", "aclaude-sonnet"]);
  expect(out.models["aclaude-haiku"]!.env).toEqual({
    CLAUDE_CODE_OAUTH_TOKEN: { file: "~/.config/claude/oauth_token_a" },
    PLAIN: "text",
  });
  expect(out.harnesses.aclaude!.adapter).toBe("claude");
});

test("an unknown top-level key or invalid YAML fails the boot naming the file", () => {
  const p = join(dir, "bad-key.yaml");
  writeFileSync(p, "harness: {}\n");
  expect(() => loadHarnesses(p, base)).toThrow(/config\.yaml|bad-key\.yaml.*"harness"/);
  const q = join(dir, "bad-yaml.yaml");
  writeFileSync(q, "harnesses: [unclosed\n  - : :\n");
  expect(() => loadHarnesses(q, base)).toThrow(/bad-yaml\.yaml/);
});

// ---- commandcode pass-through ------------------------------------------------

const catalog = [
  { id: "deepseek/deepseek-v4-pro", shortName: "deepseek-v4-pro", isDefault: false, efforts: ["low", "high"], contextWindow: 1000 },
];
const cc2 = { name: "cc2", env: { COMMAND_CODE_API_KEY: { file: "/k" } }, bin: "/opt/cc" };

test("<harness>/<id> resolves like commandcode/<id> and carries the harness env, bin and name", () => {
  const ok = resolveFromCatalog("cc2/deepseek-v4-pro", catalog, cc2);
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.model.model).toBe("deepseek/deepseek-v4-pro");
    expect(ok.model.options.reasoning_effort.values).toEqual(["low", "high"]);
    expect(ok.model.env).toEqual(cc2.env);
    expect(ok.model.bin).toBe("/opt/cc");
    expect(ok.model.harness).toBe("cc2");
  }
});

test("a plain commandcode/<id> carries no env", () => {
  const ok = resolveFromCatalog("commandcode/deepseek-v4-pro", catalog);
  expect(ok.ok && ok.model.env).toBeFalsy();
});

test("an unknown <harness>/<id> is a 404 naming the requested name", () => {
  const miss = resolveFromCatalog("cc2/nope", catalog, cc2);
  expect(miss.ok).toBe(false);
  if (!miss.ok) {
    expect(miss.status).toBe(404);
    expect(miss.message).toContain('"cc2/nope"');
  }
});

test("an ambiguous short name under a harness lists candidates with the harness prefix", () => {
  const dup = [
    { id: "a/m", shortName: "m", isDefault: false },
    { id: "b/m", shortName: "m", isDefault: false },
  ];
  const r = resolveFromCatalog("cc2/m", dup, cc2);
  expect(!r.ok && r.message).toContain("cc2/a/m");
});
