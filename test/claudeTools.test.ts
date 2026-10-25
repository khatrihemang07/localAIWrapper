import { expect, test } from "bun:test";
import { toolsFor } from "../src/backends/claude.ts";

// The tool set is what `--tools` receives, and each name costs prompt tokens,
// so these expectations pin the defaults the server promises.

test("default access (none) offers no built-in tools at all", () => {
  expect(toolsFor("none", false)).toEqual([]);
});

test("none offers no file tools even when web is on", () => {
  expect(toolsFor("none", true)).toEqual(["WebSearch", "WebFetch"]);
});

test("read-only offers the read tools and no web tools", () => {
  expect(toolsFor("read-only", false)).toEqual(["Read", "Glob", "Grep"]);
});

test("read-only never offers a write tool", () => {
  expect(toolsFor("read-only", true)).not.toContain("Edit");
  expect(toolsFor("read-only", true)).not.toContain("Write");
});

test("workspace-write adds Edit and Write on top of the read tools", () => {
  expect(toolsFor("workspace-write", false)).toEqual(["Read", "Glob", "Grep", "Edit", "Write"]);
});

test("web adds WebSearch and WebFetch only when requested", () => {
  expect(toolsFor("read-only", true)).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
  expect(toolsFor("read-only", false)).not.toContain("WebSearch");
});
