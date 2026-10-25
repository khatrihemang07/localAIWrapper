import { expect, test } from "bun:test";
import { runCli } from "../src/backends/cli.ts";
import { buildClaudeArgs } from "../src/backends/claude.ts";
import { buildCodexArgs } from "../src/backends/codex.ts";
import type { TurnRequest } from "../src/backends/index.ts";

// The prompt reaches both CLIs on stdin, never as an argv token: argv is
// limited (E2BIG on a long prompt) and a prompt starting with "-" is read as a flag.

test("runCli writes the spawn's stdin payload and closes it, so a stdin-reading child finishes", async () => {
  const payload = "x".repeat(300_000) + "\n";
  const run = runCli("cat", [], (line) => ({ text: line }), new AbortController().signal, {
    cwd: process.cwd(),
    apiKeyVars: [],
    stdin: payload,
  });
  let received = "";
  for await (const d of run.events) received += d.text ?? "";
  const outcome = await run.finish();
  expect(outcome.failure).toBeUndefined();
  expect(received.length).toBe(payload.length - 1); // the trailing newline is the line break
});

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: {
    backend: "claude",
    model: "haiku",
    systemPrompt: "- starts with a dash",
    options: {} as TurnRequest["model"]["options"],
  },
  prompt: "SECRET-PROMPT-TEXT",
  stream: false,
  web: false,
  access: "none",
  workdir: process.cwd(),
  ...over,
});

test("claude receives the prompt on stdin, not as an argument", () => {
  const args = buildClaudeArgs(req());
  expect(args).toContain("-p");
  expect(args.some((a) => a.includes("SECRET-PROMPT-TEXT"))).toBe(false);
});

test("a claude system prompt starting with '-' is passed in =-form so it is not read as a flag", () => {
  const args = buildClaudeArgs(req());
  expect(args).toContain("--system-prompt=- starts with a dash");
  expect(args).not.toContain("--system-prompt");
});

test("codex reads its prompt from stdin via exec -, never as an argument", () => {
  const args = buildCodexArgs(req({ model: { ...req().model, backend: "codex", model: "gpt-x" } }));
  expect(args[0]).toBe("exec");
  expect(args[1]).toBe("-");
  expect(args.some((a) => a.includes("SECRET-PROMPT-TEXT"))).toBe(false);
});
