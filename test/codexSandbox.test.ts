import { expect, test } from "bun:test";
import { sandboxFor } from "../src/backends/codex.ts";

// codex has no tool-less mode, so its access values map straight onto its
// sandbox: read-only (the default) and workspace-write. `none` is not a codex
// access value at all (see models.json / src/config.ts).

test("read-only maps to the read-only sandbox", () => {
  expect(sandboxFor("read-only")).toBe("read-only");
});

test("workspace-write maps to the workspace-write sandbox", () => {
  expect(sandboxFor("workspace-write")).toBe("workspace-write");
});

// ---- images (docs/adr/0011) ----

import { buildCodexArgs, codexPrompt } from "../src/backends/codex.ts";
import type { TurnRequest } from "../src/backends/index.ts";

const turn = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: { backend: "codex", model: "gpt-x", options: {} as TurnRequest["model"]["options"] },
  prompt: "Human: hi",
  stream: false,
  web: false,
  access: "read-only",
  workdir: "/w",
  ...over,
});
const pics = [{ path: "/tmp/x/img-1.png", mime: "image/png" }, { path: "/tmp/x/img-2.webp", mime: "image/webp" }];

test("codex gets one -i per image", () => {
  const args = buildCodexArgs(turn({ images: pics }));
  expect(args.slice(-4)).toEqual(["-i", "/tmp/x/img-1.png", "-i", "/tmp/x/img-2.webp"]);
});

test("codex lists the image paths in the prompt text as well", () => {
  expect(codexPrompt(turn({ images: pics }))).toBe(
    "Human: hi\n\nAttached image files (also attached to this message):\n- /tmp/x/img-1.png\n- /tmp/x/img-2.webp",
  );
});

test("regression: a Turn without images has the exact codex argv and prompt it always had", () => {
  for (const t of [turn(), turn({ images: [] })]) {
    expect(buildCodexArgs(t)).toEqual([
      "exec", "-", "-m", "gpt-x", "-s", "read-only", "-C", "/w", "--ephemeral", "--skip-git-repo-check", "--json",
      "-c", 'web_search="disabled"',
    ]);
    expect(codexPrompt(t)).toBe("Human: hi");
  }
});
