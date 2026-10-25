// The only file in this project that knows the `commandcode` binary exists,
// what flags it takes, where its model catalog is cached, or which environment
// variables it reads for billing. See docs/adr/0008-commandcode-live-passthrough.md.
//
// Verified CLI behaviour (v1.88.0, live probing):
// - `-p --output-format json` writes NDJSON. Every line but the last is
//   {"type":"event","event":{…}}. Streamed text arrives as
//   {"type":"event","event":{"type":"text_delta","delta":"…"}}.
// - The last line is {"type":"result","subtype":"success","finalText":"…",
//   "usage":{"inputTokens":…,"outputTokens":…,…}}. finalText is the whole answer.
// - `--effort` confirms on stderr only; stdout stays NDJSON.
// - `-m` takes a catalog id or its short name (text after the last "/"), and
//   matches case-insensitively. Hidden catalog entries are refused ("no longer
//   available"), so they are not resolvable here.
// - Without `--yolo` a headless run blocks file writes (tool_hook_blocked). This
//   file never passes `--yolo`, so access is read-only only.
// - An unknown model exits 1 with the error on stderr and nothing on stdout.
// - `--list-models` prints rows of "<id>  <description>" between an
//   "Available models" header and a "Pass the full id" footer. Its ids are
//   lowercase; the cache keeps the catalog's own case.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ModelConfig, resolveModelOptions } from "../config.ts";
import type { Backend, DecodedLine, TurnRequest, TurnRun, Usage } from "./index.ts";
import { childEnvironment, jsonLineDecoder, runCli, stderrTail } from "./cli.ts";

const BIN = "commandcode";

/**
 * Credentials that would make `commandcode` bill against the account's API
 * key instead of the login. Stripped from the child's environment.
 */
export const API_KEY_VARS = ["COMMAND_CODE_API_KEY"];

/** Every commandcode Model is named with this prefix on the request's `model`. */
export const MODEL_PREFIX = "commandcode/";

/** Where the CLI keeps the catalog it last fetched. Read, never written. */
const CACHE_DIR = join(homedir(), ".commandcode", "cache", "model-catalog", "v1");

// ---- catalog ---------------------------------------------------------------

/** One model the CLI can run, as the catalog (or its listing) describes it. */
export type CatalogEntry = {
  /** The id `-m` takes. Case as the source reports it; `-m` ignores case. */
  id: string;
  /** The id's text after its last "/", which `-m` also accepts. */
  shortName: string;
  isDefault: boolean;
  /** Reasoning efforts the catalog lists. Undefined when no catalog metadata is available. */
  efforts?: string[];
  /** The catalog's context length, when it has one. */
  contextWindow?: number;
};

export function shortNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/**
 * The CLI's cached catalog, used as it stands: no freshness check, so a stale
 * cache is served as is. Reads the newest `catalog-*.json` by its `fetchedAt`.
 * Undefined when no readable cache exists. Hidden entries are left out, since
 * the CLI refuses them.
 */
export function readCatalogCache(dir: string = CACHE_DIR): CatalogEntry[] | undefined {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^catalog-.*\.json$/u.test(f));
  } catch {
    return undefined;
  }

  let newest: { fetchedAt: number; body: any } | undefined;
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const fetchedAt = typeof parsed?.fetchedAt === "number" ? parsed.fetchedAt : 0;
      if (Array.isArray(parsed?.body?.data) && (newest === undefined || fetchedAt > newest.fetchedAt)) {
        newest = { fetchedAt, body: parsed.body };
      }
    } catch {
      // An unreadable file is skipped; another cache file may still be usable.
    }
  }
  if (!newest) return undefined;

  const defaultId = newest.body.roles?.default;
  const entries: CatalogEntry[] = [];
  for (const m of newest.body.data) {
    if (typeof m?.id !== "string" || m.hidden === true) continue;
    entries.push({
      id: m.id,
      shortName: shortNameOf(m.id),
      isDefault: m.id === defaultId,
      efforts: Array.isArray(m.reasoningEfforts)
        ? m.reasoningEfforts.filter((e: unknown): e is string => typeof e === "string")
        : [],
      ...(typeof m.context_length === "number" ? { contextWindow: m.context_length } : {}),
    });
  }
  return entries;
}

/**
 * Parses `commandcode --list-models`. Only the rows between the header and the
 * footer count: group titles have no two-space column, and the footer and
 * decision-model notes sit outside that range. Throws when the markers are
 * missing, since that means the CLI's output changed.
 */
export function parseModelList(text: string): CatalogEntry[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("Available models"));
  const end = lines.findIndex((l) => l.startsWith("Pass the full id"));
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`unrecognised output from ${BIN} --list-models`);
  }

  const entries: CatalogEntry[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const row = /^(\S+)\s{2,}(\S.*)$/u.exec(line.trimEnd());
    if (!row) continue;
    const [, id, description] = row as unknown as [string, string, string];
    entries.push({ id, shortName: shortNameOf(id), isDefault: /\(default\)$/u.test(description) });
  }
  return entries;
}

/** Runs `commandcode --list-models`. Throws when the CLI cannot be run or fails. */
export async function listCommandcodeModels(): Promise<CatalogEntry[]> {
  const proc = Bun.spawn([BIN, "--list-models"], {
    env: childEnvironment(Bun.env, API_KEY_VARS),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${BIN} --list-models exited with code ${code}: ${stderrTail(stderr)}`);
  }
  return parseModelList(stdout);
}

/**
 * The catalog a request is resolved against: the CLI's cache when it exists,
 * otherwise a live listing (which carries no efforts or context windows).
 */
export async function loadCatalog(
  cacheDir: string = CACHE_DIR,
  list: () => Promise<CatalogEntry[]> = listCommandcodeModels,
): Promise<CatalogEntry[]> {
  return readCatalogCache(cacheDir) ?? (await list());
}

/**
 * The listing for GET /v1/commandcode/models: the CLI's own list, with each
 * row's efforts and context window merged in from the cache where it has them.
 */
export async function discoverCommandcodeModels(cacheDir: string = CACHE_DIR): Promise<CatalogEntry[]> {
  const listed = await listCommandcodeModels();
  const cached = readCatalogCache(cacheDir);
  if (!cached) return listed;
  const byId = new Map(cached.map((e) => [e.id.toLowerCase(), e]));
  return listed.map((e) => {
    const c = byId.get(e.id.toLowerCase());
    return c ? { ...e, efforts: c.efforts, contextWindow: c.contextWindow } : e;
  });
}

// ---- model resolution ------------------------------------------------------

export type ResolutionFailure = {
  ok: false;
  status: number;
  message: string;
  type: string;
  code: string | null;
};

export type ResolutionResult = { ok: true; model: ModelConfig } | ResolutionFailure;

/**
 * The Model a commandcode request names. The name after the prefix is matched
 * first as a full id, then as a short name. Matching ignores case. Two short
 * names matching is a 400 that lists the candidates.
 */
export function resolveFromCatalog(requested: string, catalog: CatalogEntry[]): ResolutionResult {
  const name = requested.slice(MODEL_PREFIX.length).toLowerCase();
  let entry = catalog.find((e) => e.id.toLowerCase() === name);
  if (!entry) {
    const matches = catalog.filter((e) => e.shortName.toLowerCase() === name);
    if (matches.length > 1) {
      const candidates = matches.map((m) => `${MODEL_PREFIX}${m.id}`).join(", ");
      return {
        ok: false,
        status: 400,
        message: `"${requested}" matches more than one commandcode model; use the full id. Candidates: ${candidates}`,
        type: "invalid_request_error",
        code: null,
      };
    }
    entry = matches[0];
  }
  if (!entry) {
    return {
      ok: false,
      status: 404,
      message: `Unknown model "${requested}". List the commandcode models at GET /v1/commandcode/models`,
      type: "invalid_request_error",
      code: "model_not_found",
    };
  }

  // Efforts are offered only when the catalog lists some. Without catalog
  // metadata (the live-listing fallback) none are offered.
  const efforts = entry.efforts && entry.efforts.length > 0 ? entry.efforts : undefined;
  const options = resolveModelOptions(
    entry.id,
    "commandcode",
    efforts
      ? {
          reasoning_effort: {
            supported: true,
            values: efforts,
            default: null,
            description: `Reasoning effort passed as commandcode --effort. Accepted values for ${entry.id}: ${efforts.join(", ")}.`,
          },
        }
      : {},
  );
  return {
    ok: true,
    model: {
      backend: "commandcode",
      model: entry.id,
      options,
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    },
  };
}

/** Resolves a `commandcode/...` request name against the live catalog. */
export async function resolveCommandcodeModel(requested: string): Promise<ResolutionResult> {
  return resolveFromCatalog(requested, await loadCatalog());
}

// ---- decoding --------------------------------------------------------------

/**
 * The CLI reports usage in camelCase. `inputTokens` is the whole prompt as
 * observed in probes (`cacheReadTokens` is a part of it, not an addition).
 */
function commandcodeUsage(raw: any): Usage | undefined {
  if (!raw) return undefined;
  return {
    promptTokens: raw.inputTokens,
    completionTokens: raw.outputTokens,
    totalTokens: (raw.inputTokens ?? 0) + (raw.outputTokens ?? 0),
  };
}

function decodeEvent(obj: any): DecodedLine | null {
  if (obj?.type === "event" && obj.event?.type === "text_delta") {
    const delta = obj.event.delta;
    return typeof delta === "string" ? { text: delta } : null;
  }

  if (obj?.type === "result") {
    const usage = commandcodeUsage(obj.usage);
    const finalText = typeof obj.finalText === "string" ? obj.finalText : undefined;
    // The final line carries the whole answer, so it replaces the deltas
    // (bufferedResponse keeps the last text it sees). On a non-success
    // subtype the text is the CLI's own message; its shape for failures
    // is not verified, so a generic message covers its absence.
    if (obj.subtype === "success") {
      return { text: finalText, usage, final: true };
    }
    return { error: finalText || "commandcode reported an error", usage, final: true };
  }

  return null;
}

/** One stdout line of a Turn, decoded. Exported for the decoder tests. */
export const decodeLine = jsonLineDecoder(decodeEvent);

// ---- invocation ------------------------------------------------------------

/**
 * The argv for one Turn. The prompt is not here: it goes on stdin. `--safe-mode`,
 * `--no-skills` and `--skip-onboarding` keep the run to the bare Model. `--yolo`
 * is never passed, so writes and shell commands stay blocked.
 */
export function buildCommandcodeArgs(req: TurnRequest): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    "json",
    "--no-session",
    "--skip-onboarding",
    "--no-skills",
    "--safe-mode",
    "-m",
    req.model.model,
  ];
  if (req.reasoningEffort) {
    args.push("--effort", req.reasoningEffort);
  }
  return args;
}

/**
 * commandcode has no system-prompt flag, so the system prompt is prepended to
 * the user prompt. A pass-through Model carries none of its own, so this only
 * ever applies to a system message sent with the request.
 */
function composePrompt(model: ModelConfig, prompt: string): string {
  return model.systemPrompt ? `${model.systemPrompt}\n\n${prompt}` : prompt;
}

export const commandcodeBackend: Backend = {
  label: "commandcode",
  // Measured: the CLI emits text_delta events as the answer is generated.
  streaming: true,
  jsonSchema: false,
  run(req: TurnRequest, signal: AbortSignal): TurnRun {
    return runCli(BIN, buildCommandcodeArgs(req), decodeLine, signal, {
      cwd: req.workdir,
      apiKeyVars: API_KEY_VARS,
      stdin: composePrompt(req.model, req.prompt),
    });
  },
};
