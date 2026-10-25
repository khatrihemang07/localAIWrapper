import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkdir } from "../src/workdir.ts";

let base: string;
let root: string;
let sibling: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "workdir-test-")));
  root = join(base, "root");
  sibling = join(base, "root-evil"); // shares the prefix "root" but is not inside it
  outside = join(base, "outside");
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(sibling);
  mkdirSync(outside);
  writeFileSync(join(root, "file.txt"), "x");
  symlinkSync(outside, join(root, "escape-link"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("a directory inside an allowed root resolves to its realpath", () => {
  const r = resolveWorkdir(join(root, "project"), [root]);
  expect(r).toEqual({ ok: true, path: join(root, "project") });
});

test("the root itself is allowed", () => {
  const r = resolveWorkdir(root, [root]);
  expect(r.ok).toBe(true);
});

test("a directory outside every root is rejected", () => {
  const r = resolveWorkdir(outside, [root]);
  expect(r.ok).toBe(false);
});

test("a .. segment that climbs out of the root is rejected", () => {
  // Raw string on purpose: path.join would normalise the `..` away before the
  // resolver ever sees it.
  const r = resolveWorkdir(`${root}/project/../../outside`, [root]);
  expect(r.ok).toBe(false);
});

test("a symlink inside the root that points outside is rejected", () => {
  const r = resolveWorkdir(join(root, "escape-link"), [root]);
  expect(r.ok).toBe(false);
});

test("a sibling directory sharing the root's name prefix is rejected", () => {
  const r = resolveWorkdir(sibling, [root]);
  expect(r.ok).toBe(false);
});

test("a relative path is rejected", () => {
  const r = resolveWorkdir("project", [root]);
  expect(r.ok).toBe(false);
});

test("a path that does not exist is rejected", () => {
  const r = resolveWorkdir(join(root, "missing"), [root]);
  expect(r.ok).toBe(false);
});

test("a regular file is rejected even when inside a root", () => {
  const r = resolveWorkdir(join(root, "file.txt"), [root]);
  expect(r.ok).toBe(false);
});

test("any one of several roots is enough", () => {
  const r = resolveWorkdir(join(outside), [root, outside]);
  expect(r.ok).toBe(true);
});

test("outside-root, nonexistent and non-directory paths all get the same generic message", () => {
  const outsideMsg = resolveWorkdir(outside, [root]);
  const missingMsg = resolveWorkdir(join(outside, "does-not-exist"), [root]);
  const missingRootMsg = resolveWorkdir(join(root, "missing"), [root]);
  const fileMsg = resolveWorkdir(join(root, "file.txt"), [root]);
  const expected = `"workdir" is not an allowed directory`;
  for (const r of [outsideMsg, missingMsg, missingRootMsg, fileMsg]) {
    expect(r).toEqual({ ok: false, message: expected });
  }
});

test("an existing directory outside the roots is indistinguishable from a missing one", () => {
  const existing = resolveWorkdir(outside, [root]);
  const missing = resolveWorkdir(join(base, "no-such-dir"), [root]);
  expect(existing).toEqual(missing);
});
