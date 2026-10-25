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
