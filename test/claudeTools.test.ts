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

// ---- images (docs/adr/0011) ----

import { buildClaudeArgs, claudePrompt } from "../src/backends/claude.ts";
import type { TurnRequest } from "../src/backends/index.ts";

const turn = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: { backend: "claude", model: "haiku", options: {} as TurnRequest["model"]["options"] },
  prompt: "Human: hi",
  stream: false,
  web: false,
  access: "none",
  workdir: process.cwd(),
  ...over,
});
const pics = [{ path: "/tmp/x/img-1.png", mime: "image/png" }, { path: "/tmp/x/img-2.jpg", mime: "image/jpeg" }];

test("images add only Read, not Glob or Grep", () => {
  expect(toolsFor("none", false, true)).toEqual(["Read"]);
  expect(toolsFor("none", true, true)).toEqual(["Read", "WebSearch", "WebFetch"]);
});

test("images with read-only or workspace-write do not list Read twice", () => {
  expect(toolsFor("read-only", false, true)).toEqual(["Read", "Glob", "Grep"]);
  expect(toolsFor("workspace-write", false, true)).toEqual(["Read", "Glob", "Grep", "Edit", "Write"]);
});

test("an image Turn passes Read to both --tools and --allowed-tools and keeps access none otherwise", () => {
  const args = buildClaudeArgs(turn({ images: pics }));
  expect(args[args.indexOf("--tools") + 1]).toBe("Read");
  expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Read");
});

test("an image Turn appends the paths to the prompt", () => {
  expect(claudePrompt(turn({ images: pics }))).toBe(
    "Human: hi\n\nAttached image files (view each with the Read tool):\n- /tmp/x/img-1.png\n- /tmp/x/img-2.jpg",
  );
});

test("regression: a Turn without images has the exact argv and prompt it always had", () => {
  for (const t of [turn(), turn({ images: [] })]) {
    expect(buildClaudeArgs(t)).toEqual([
      "-p", "--model", "haiku", "--safe-mode", "--no-session-persistence", "--no-chrome",
      "--tools", "", "--allowed-tools", "", "--output-format", "stream-json", "--verbose",
    ]);
    expect(claudePrompt(t)).toBe("Human: hi");
  }
  expect(toolsFor("none", false)).toEqual([]);
});
