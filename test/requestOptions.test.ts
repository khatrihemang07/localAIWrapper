import { expect, test } from "bun:test";
import { parseRequestOptions } from "../src/requestOptions.ts";
import type { ModelOptions } from "../src/config.ts";

// A Model that supports every option. Shape mirrors models.json.
const full: ModelOptions = {
  reasoning_effort: { supported: true, values: ["low", "high"], default: null, description: "effort" },
  web: { supported: true, values: [false, true], default: false, description: "web" },
  access: { supported: true, values: ["none", "read-only", "workspace-write"], default: "none", description: "access" },
  workdir: { supported: true, values: null, default: null, description: "workdir" },
};

// A Model that declares none of the optional features.
const bare: ModelOptions = {
  reasoning_effort: { supported: false, values: null, default: null, description: "effort" },
  web: { supported: false, values: [false], default: false, description: "web" },
  access: { supported: false, values: ["none"], default: "none", description: "access" },
  workdir: { supported: false, values: null, default: null, description: "workdir" },
};

const schema = { type: "object", properties: { a: { type: "string" } } };

function ok(body: Record<string, unknown>, options: ModelOptions) {
  const r = parseRequestOptions(body, options);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.value;
}

test("an empty body resolves to the documented defaults", () => {
  const v = ok({}, full);
  expect(v.web).toBe(false);
  expect(v.access).toBe("none");
  expect(v.reasoningEffort).toBeUndefined();
  expect(v.workdir).toBeUndefined();
  expect(v.responseFormat).toBeUndefined();
});

test("null is treated the same as absent for every option", () => {
  const v = ok({ web: null, access: null, reasoning_effort: null, workdir: null, response_format: null }, bare);
  expect(v.web).toBe(false);
  expect(v.access).toBe("none");
});

test("web: true is rejected on a Model that does not support it", () => {
  expect(parseRequestOptions({ web: true }, bare).ok).toBe(false);
});

test("web: false is accepted on a Model that does not support it", () => {
  expect(ok({ web: false }, bare).web).toBe(false);
});

test("web: true is accepted on a supporting Model", () => {
  expect(ok({ web: true }, full).web).toBe(true);
});

test("web must be a boolean", () => {
  expect(parseRequestOptions({ web: "yes" }, full).ok).toBe(false);
});

test("access must be one of the Model's declared values", () => {
  expect(ok({ access: "workspace-write" }, full).access).toBe("workspace-write");
  expect(parseRequestOptions({ access: "danger-full-access" }, full).ok).toBe(false);
});

test("access is rejected when the Model does not declare it", () => {
  expect(parseRequestOptions({ access: "read-only" }, bare).ok).toBe(false);
});

test("reasoning_effort must be a declared value and needs support", () => {
  expect(ok({ reasoning_effort: "high" }, full).reasoningEffort).toBe("high");
  expect(parseRequestOptions({ reasoning_effort: "max" }, full).ok).toBe(false);
  expect(parseRequestOptions({ reasoning_effort: "high" }, bare).ok).toBe(false);
});

test("workdir passes through as a string and needs support", () => {
  expect(ok({ workdir: "/some/abs" }, full).workdir).toBe("/some/abs");
  expect(parseRequestOptions({ workdir: "/x" }, bare).ok).toBe(false);
  expect(parseRequestOptions({ workdir: 42 }, full).ok).toBe(false);
});

test("response_format json_schema is accepted and carries its name and schema", () => {
  const v = ok({ response_format: { type: "json_schema", json_schema: { name: "thing", schema, strict: true } } }, bare);
  expect(v.responseFormat).toEqual({ name: "thing", schema, strict: true });
});

test("response_format of any other type is rejected", () => {
  expect(parseRequestOptions({ response_format: { type: "json_object" } }, full).ok).toBe(false);
  expect(parseRequestOptions({ response_format: { type: "grammar" } }, full).ok).toBe(false);
  expect(parseRequestOptions({ response_format: "json_schema" }, full).ok).toBe(false);
  expect(parseRequestOptions({ response_format: "text" }, full).ok).toBe(false);
});

test("response_format {type:\"text\"} is accepted as a no-op: no schema, no constraint", () => {
  const v = ok({ response_format: { type: "text" } }, bare);
  expect(v.responseFormat).toBeUndefined();
});

test("a malformed json_schema is rejected", () => {
  const bad = (js: unknown) => parseRequestOptions({ response_format: { type: "json_schema", json_schema: js } }, full).ok;
  expect(bad(undefined)).toBe(false);
  expect(bad({ schema })).toBe(false); // no name
  expect(bad({ name: "", schema })).toBe(false);
  expect(bad({ name: "x" })).toBe(false); // no schema
  expect(bad({ name: "x", schema: [] })).toBe(false); // array is not an object schema
  expect(bad({ name: "x", schema, strict: "yes" })).toBe(false);
});

test("sending the default of an unsupported option is accepted for every option", () => {
  const v = ok({ web: false, access: "none", reasoning_effort: null, workdir: null }, bare);
  expect(v.web).toBe(false);
  expect(v.access).toBe("none");
  expect(v.workdir).toBeUndefined();
});

test("a non-default value on an unsupported access option is a 400", () => {
  expect(parseRequestOptions({ access: "read-only" }, bare).ok).toBe(false);
  expect(parseRequestOptions({ access: "workspace-write" }, bare).ok).toBe(false);
});

test("a non-default value on an unsupported workdir or reasoning_effort is a 400", () => {
  expect(parseRequestOptions({ workdir: "/x" }, bare).ok).toBe(false);
  expect(parseRequestOptions({ reasoning_effort: "low" }, bare).ok).toBe(false);
});

// A codex-shaped Model: its access values are read-only and workspace-write.
const codexAccess: ModelOptions = {
  ...bare,
  access: { supported: true, values: ["read-only", "workspace-write"], default: "read-only", description: "access" },
};

test("codex access: none is no longer a value and is a 400", () => {
  expect(parseRequestOptions({ access: "none" }, codexAccess).ok).toBe(false);
});

test("codex access defaults to read-only when omitted", () => {
  expect(ok({}, codexAccess).access).toBe("read-only");
});
