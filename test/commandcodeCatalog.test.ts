import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatalogEntry,
  loadCatalog,
  parseModelList,
  readCatalogCache,
  resolveFromCatalog,
} from "../src/backends/commandcode.ts";
import { commandcodeModelList } from "../src/discovery.ts";
import { parseRequestOptions } from "../src/requestOptions.ts";
import { resolveModelOptions } from "../src/config.ts";

// Fixtures: the cache file is a trimmed copy of the CLI's real catalog
// (~/.commandcode/cache/model-catalog/v1/), keeping its exact shape and a real
// hidden entry; the listing is the real `commandcode --list-models` output.

const CACHE_DIR = new URL("./fixtures/commandcode-catalog", import.meta.url).pathname;
const LISTING = readFileSync(new URL("./fixtures/commandcode-list-models.txt", import.meta.url), "utf8");

const cached = () => readCatalogCache(CACHE_DIR) as CatalogEntry[];

// ---- the cache reader ----------------------------------------------------

test("the cache reader keeps visible entries and drops hidden ones", () => {
  const ids = cached().map((e) => e.id).sort();
  expect(ids).toEqual(["claude-haiku-5-5", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-fast", "gpt-5.6-sol", "moonshotai/Kimi-K2.5"]);
  expect(ids).not.toContain("minimax/minimax-m2.7-free");
});

test("the cache reader takes efforts, context window, short name and the catalog default", () => {
  const byId = Object.fromEntries(cached().map((e) => [e.id, e]));
  expect(byId["deepseek/deepseek-v4-flash"]).toEqual({
    id: "deepseek/deepseek-v4-flash",
    shortName: "deepseek-v4-flash",
    isDefault: true,
    efforts: ["off", "high", "max"],
    contextWindow: 1000000,
  });
  expect(byId["deepseek/deepseek-v4-flash-fast"]?.isDefault).toBe(false);
  expect(byId["claude-haiku-5-5"]?.shortName).toBe("claude-haiku-5-5");
});

test("a catalog entry with no reasoningEfforts key reads as having none", () => {
  expect(byIdOf("moonshotai/Kimi-K2.5").efforts).toEqual([]);
  expect(byIdOf("moonshotai/Kimi-K2.5").contextWindow).toBe(256000);
});

function byIdOf(id: string): CatalogEntry {
  const e = cached().find((c) => c.id === id);
  if (!e) throw new Error(`fixture is missing ${id}`);
  return e;
}

test("a missing cache directory reads as no cache", () => {
  expect(readCatalogCache(join(tmpdir(), "no-such-commandcode-cache-dir"))).toBeUndefined();
});

test("a cache directory with no readable catalog reads as no cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmd-cache-"));
  try {
    writeFileSync(join(dir, "catalog-bad.json"), "{not json");
    writeFileSync(join(dir, "other.json"), "{}");
    expect(readCatalogCache(dir)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when several cache files exist the newest by fetchedAt is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmd-cache-"));
  try {
    const file = (fetchedAt: number, id: string) =>
      JSON.stringify({ fetchedAt, body: { data: [{ id, reasoningEfforts: [] }], roles: {} } });
    writeFileSync(join(dir, "catalog-old.json"), file(1, "old/model"));
    writeFileSync(join(dir, "catalog-new.json"), file(2, "new/model"));
    expect(readCatalogCache(dir)?.map((e) => e.id)).toEqual(["new/model"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the listing parser --------------------------------------------------

test("the listing parser reads the real --list-models output into 93 rows", () => {
  const rows = parseModelList(LISTING);
  expect(rows).toHaveLength(93);
  expect(rows[0]).toEqual({ id: "deepseek/deepseek-v4-pro", shortName: "deepseek-v4-pro", isDefault: false });
});

test("the listing parser marks the (default) row and skips group titles, footer and decision models", () => {
  const rows = parseModelList(LISTING);
  expect(rows.filter((r) => r.isDefault).map((r) => r.id)).toEqual(["deepseek/deepseek-v4-flash"]);
  const ids = rows.map((r) => r.id);
  expect(ids).not.toContain("Docs:");
  expect(ids).not.toContain("typesafe/jev");
  expect(ids).not.toContain("Anthropic");
  expect(ids).not.toContain("cmd");
});

test("the listing parser refuses output whose markers are missing", () => {
  expect(() => parseModelList("something else entirely")).toThrow(/unrecognised output/);
});

// ---- catalog source: cache first, listing as fallback --------------------

test("with a cache present the catalog is the cache and the listing is not run", async () => {
  const catalog = await loadCatalog(CACHE_DIR, async () => {
    throw new Error("listing must not run when the cache exists");
  });
  expect(catalog.map((e) => e.id)).toContain("deepseek/deepseek-v4-flash");
});

test("with no cache the catalog falls back to the listing, which carries no efforts or context window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmd-nocache-"));
  try {
    const catalog = await loadCatalog(dir, async () => parseModelList(LISTING));
    expect(catalog).toHaveLength(93);
    expect(catalog[1]?.efforts).toBeUndefined();
    expect(catalog[1]?.contextWindow).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- resolution: exact id, short name, ambiguity, unknown ----------------

test("a full id resolves to that Model, case-insensitively", () => {
  const r = resolveFromCatalog("commandcode/deepseek/deepseek-v4-flash", cached());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.model.backend).toBe("commandcode");
  expect(r.model.model).toBe("deepseek/deepseek-v4-flash");
  expect(r.model.contextWindow).toBe(1000000);
});

test("a short name resolves to the same Model as its full id", () => {
  const a = resolveFromCatalog("commandcode/kimi-k2.5", cached());
  const b = resolveFromCatalog("commandcode/Kimi-K2.5", cached());
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  expect(a.model.model).toBe("moonshotai/Kimi-K2.5");
  expect(b.model.model).toBe("moonshotai/Kimi-K2.5");
});

test("a short name matching several ids is a 400 that lists the candidates", () => {
  const catalog: CatalogEntry[] = [
    { id: "vendor-a/shared-name", shortName: "shared-name", isDefault: false },
    { id: "vendor-b/shared-name", shortName: "shared-name", isDefault: false },
  ];
  const r = resolveFromCatalog("commandcode/shared-name", catalog);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.status).toBe(400);
  expect(r.message).toContain("commandcode/vendor-a/shared-name");
  expect(r.message).toContain("commandcode/vendor-b/shared-name");
});

test("an unknown id is a 404 with the model_not_found code", () => {
  const r = resolveFromCatalog("commandcode/no-such-model", cached());
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.status).toBe(404);
  expect(r.code).toBe("model_not_found");
  expect(r.message).toContain("GET /v1/commandcode/models");
});

test("a hidden entry cannot be resolved, because the CLI refuses it", () => {
  const r = resolveFromCatalog("commandcode/minimax/minimax-m2.7-free", cached());
  expect(r.ok).toBe(false);
});

// ---- reasoning_effort validated against the catalog ----------------------

function optionsFor(requested: string, catalog: CatalogEntry[] = cached()) {
  const r = resolveFromCatalog(requested, catalog);
  if (!r.ok) throw new Error(r.message);
  return r.model.options;
}

test("a catalog effort is accepted and an effort outside the list is a 400 that lists the values", () => {
  const options = optionsFor("commandcode/deepseek/deepseek-v4-flash");
  expect(parseRequestOptions({ reasoning_effort: "high" }, options).ok).toBe(true);
  const bad = parseRequestOptions({ reasoning_effort: "xhigh" }, options);
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.message).toBe(`"reasoning_effort" must be one of: off, high, max`);
});

test("a model whose catalog lists no efforts refuses reasoning_effort", () => {
  const options = optionsFor("commandcode/moonshotai/Kimi-K2.5");
  const r = parseRequestOptions({ reasoning_effort: "high" }, options);
  expect(r.ok).toBe(false);
});

test("with no catalog metadata (the listing fallback) every reasoning_effort is refused", () => {
  const catalog = parseModelList(LISTING);
  const options = optionsFor("commandcode/deepseek/deepseek-v4-flash", catalog);
  expect(parseRequestOptions({ reasoning_effort: "high" }, options).ok).toBe(false);
  expect(parseRequestOptions({}, options).ok).toBe(true);
});

test("access accepts only read-only, and web accepts only false", () => {
  const options = optionsFor("commandcode/deepseek/deepseek-v4-flash");
  expect(parseRequestOptions({}, options)).toMatchObject({ ok: true, value: { access: "read-only", web: false } });
  expect(parseRequestOptions({ access: "read-only" }, options).ok).toBe(true);
  expect(parseRequestOptions({ access: "none" }, options).ok).toBe(false);
  expect(parseRequestOptions({ access: "workspace-write" }, options).ok).toBe(false);
  expect(parseRequestOptions({ web: true }, options).ok).toBe(false);
  expect(parseRequestOptions({ web: false }, options).ok).toBe(true);
});

test("a commandcode Model's options come from the backend's shared declarations", () => {
  const shared = resolveModelOptions("x", "commandcode");
  expect(shared.reasoning_effort.supported).toBe(false);
  expect(shared.access.values).toEqual(["read-only"]);
  expect(shared.web.supported).toBe(false);
  expect(shared.workdir.supported).toBe(true);
});

// ---- discovery listing ---------------------------------------------------

test("the discovery list shows full ids, short names, efforts, context window and the default flag", () => {
  const list = commandcodeModelList(cached(), null);
  expect(list.object).toBe("list");
  const flash = list.data.find((m) => m.id === "commandcode/deepseek/deepseek-v4-flash");
  expect(flash).toMatchObject({
    object: "model",
    owned_by: "commandcode",
    local_ai_wrapper: {
      backend: "commandcode",
      short_name: "deepseek-v4-flash",
      efforts: ["off", "high", "max"],
      contextWindow: 1000000,
      default: true,
    },
  });
});

test("discovery omits efforts and context window when the catalog says nothing", () => {
  const list = commandcodeModelList(parseModelList(LISTING), null);
  const row = list.data[0];
  expect(row).toBeDefined();
  expect(row?.local_ai_wrapper).not.toHaveProperty("efforts");
  expect(row?.local_ai_wrapper).not.toHaveProperty("contextWindow");
});

test("discovery's ?q= is a case-insensitive substring match on the id", () => {
  const ids = (q: string) => commandcodeModelList(cached(), q).data.map((m) => m.id);
  expect(ids("SPARK")).toEqual([]);
  expect(ids("flash")).toEqual([
    "commandcode/deepseek/deepseek-v4-flash",
    "commandcode/deepseek/deepseek-v4-flash-fast",
  ]);
  expect(ids("kimi-k2.5")).toEqual(["commandcode/moonshotai/Kimi-K2.5"]);
  expect(ids("")).toHaveLength(5);
});
