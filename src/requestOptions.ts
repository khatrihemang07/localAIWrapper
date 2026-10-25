// Validates the per-request options against what the resolved Model declares
// in models.json (see ModelOptions in src/config.ts). Pure: no I/O. The
// `workdir` value is returned unresolved; checking it against the filesystem
// is src/workdir.ts's job.
//
// Rule for every option: `null` and absence mean the same thing (the option
// was not requested). An option the Model does not support accepts only its
// neutral default value (a no-op); any other value is a 400, never a silent no-op.

import type { ModelOptions } from "./config.ts";

/**
 * `none` (claude's default) removes every file tool; codex has no such value
 * and offers only `read-only` (its default) and `workspace-write`. See
 * docs/adr/0007.
 */
export type Access = "none" | "read-only" | "workspace-write";

export type JsonSchemaFormat = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type RequestOptions = {
  reasoningEffort?: string;
  web: boolean;
  access: Access;
  /** Raw, unresolved `workdir` from the request. */
  workdir?: string;
  responseFormat?: JsonSchemaFormat;
};

export type ParseResult = { ok: true; value: RequestOptions } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseRequestOptions(body: Record<string, unknown>, options: ModelOptions): ParseResult {
  const fail = (message: string): ParseResult => ({ ok: false, message });
  const has = (key: string) => body[key] !== undefined && body[key] !== null;

  // ---- reasoning_effort
  let reasoningEffort: string | undefined;
  if (has("reasoning_effort")) {
    const spec = options.reasoning_effort;
    if (!spec.supported) {
      return fail(`this model does not support "reasoning_effort"`);
    }
    const v = body.reasoning_effort;
    if (typeof v !== "string" || !(spec.values ?? []).includes(v)) {
      return fail(`"reasoning_effort" must be one of: ${(spec.values ?? []).join(", ")}`);
    }
    reasoningEffort = v;
  }

  // ---- web (default false; sending the default is always accepted)
  let web = options.web.default === true;
  if (has("web")) {
    const v = body.web;
    if (typeof v !== "boolean") {
      return fail(`"web" must be a boolean`);
    }
    if (!options.web.supported && v !== options.web.default) {
      return fail(`this model does not support "web"`);
    }
    web = v;
  }

  // ---- access (default read-only)
  let access: Access = (options.access.default as Access | null) ?? "none";
  if (has("access")) {
    const spec = options.access;
    const v = body.access;
    if (!spec.supported) {
      // Unsupported: only the neutral default is accepted, and it changes nothing.
      if (v !== spec.default) {
        return fail(`this model does not support "access"`);
      }
      access = v as Access;
    } else {
      if (typeof v !== "string" || !(spec.values ?? []).includes(v)) {
        return fail(`"access" must be one of: ${(spec.values ?? []).join(", ")}`);
      }
      access = v as Access;
    }
  }

  // ---- workdir
  let workdir: string | undefined;
  if (has("workdir")) {
    if (!options.workdir.supported) {
      return fail(`this model does not support "workdir"`);
    }
    if (typeof body.workdir !== "string" || body.workdir.length === 0) {
      return fail(`"workdir" must be a non-empty string`);
    }
    workdir = body.workdir;
  }

  // ---- response_format
  // {"type":"text"} is the OpenAI default and is accepted as a no-op: it puts
  // no constraint on the answer, so it produces no schema.
  let responseFormat: JsonSchemaFormat | undefined;
  if (has("response_format") && !(isObject(body.response_format) && body.response_format.type === "text")) {
    const rf = body.response_format;
    if (!isObject(rf) || rf.type !== "json_schema") {
      return fail(`"response_format" must be {"type":"text"} or {"type":"json_schema","json_schema":{...}}; no other type is supported`);
    }
    const js = rf.json_schema;
    if (!isObject(js)) {
      return fail(`"response_format.json_schema" must be an object`);
    }
    if (typeof js.name !== "string" || js.name.length === 0) {
      return fail(`"response_format.json_schema.name" must be a non-empty string`);
    }
    if (!isObject(js.schema)) {
      return fail(`"response_format.json_schema.schema" must be a JSON Schema object`);
    }
    if (js.strict !== undefined && typeof js.strict !== "boolean") {
      return fail(`"response_format.json_schema.strict" must be a boolean`);
    }
    responseFormat = {
      name: js.name,
      schema: js.schema,
      ...(js.strict !== undefined ? { strict: js.strict as boolean } : {}),
    };
  }

  return {
    ok: true,
    value: { reasoningEffort, web, access, workdir, responseFormat },
  };
}
