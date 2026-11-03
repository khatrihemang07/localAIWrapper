import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment, resolveEnv, runCli } from "../src/backends/cli.ts";
import { API_KEY_VARS as COMMANDCODE_API_KEY_VARS } from "../src/backends/commandcode.ts";

const CLAUDE_BILLING = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

test("drops API-key vars so the subscription login is used", () => {
  const out = childEnvironment(
    { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://evil" },
    CLAUDE_BILLING,
  );
  expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(out.PATH).toBe("/bin");
  expect(out.HOME).toBe("/h");
});

test("drops GIT_* vars and parent-session vars", () => {
  const out = childEnvironment(
    {
      GIT_DIR: "/x/.git",
      GIT_INDEX_FILE: "/x/index",
      CLAUDECODE: "1",
      CLAUDE_SESSION_ID: "abc",
      CLAUDE_PARENT_SESSION: "p",
      CODEX_THREAD_ID: "t",
      CODEX_SESSION_ID: "s",
      PI_SESSION_ID: "pi",
      KEEP_ME: "yes",
    },
    [],
  );
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "CLAUDECODE", "CLAUDE_SESSION_ID", "CLAUDE_PARENT_SESSION", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "PI_SESSION_ID"]) {
    expect(out[k]).toBeUndefined();
  }
  expect(out.KEEP_ME).toBe("yes");
});

test("sets NO_COLOR=1 and never passes undefined values", () => {
  const out = childEnvironment({ PATH: "/bin", EMPTY: undefined }, []);
  expect(out.NO_COLOR).toBe("1");
  expect("EMPTY" in out).toBe(false);
});

test("does not mutate the parent environment object", () => {
  const parent = { ANTHROPIC_API_KEY: "sk-x", GIT_DIR: "/g" };
  childEnvironment(parent, CLAUDE_BILLING);
  expect(parent.ANTHROPIC_API_KEY).toBe("sk-x");
  expect(parent.GIT_DIR).toBe("/g");
});

test("strips every CLAUDE_CODE_* variable a parent session sets, except the subscription token", () => {
  const out = childEnvironment(
    {
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "1234",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_EXECPATH: "/bin/claude",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-for-plan",
      CLAUDE_CONFIG_DIR: "/cfg",
      HOME: "/h",
    },
    CLAUDE_BILLING,
  );
  for (const k of [
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
  ]) {
    expect(out[k]).toBeUndefined();
  }
  expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-for-plan");
  expect(out.CLAUDE_CONFIG_DIR).toBe("/cfg");
  expect(out.HOME).toBe("/h");
});

test("drops the commandcode API key so the login is used", () => {
  const out = childEnvironment({ PATH: "/bin", COMMAND_CODE_API_KEY: "user_key" }, COMMANDCODE_API_KEY_VARS);
  expect(out.COMMAND_CODE_API_KEY).toBeUndefined();
  expect(out.PATH).toBe("/bin");
});

test("drops commandcode session and parent markers, but keeps the user's own CMD_ and COMMAND_CODE_ settings", () => {
  const out = childEnvironment(
    {
      CMD_SESSION_ID: "s",
      CMD_PARENT_SESSION: "p",
      COMMAND_CODE_SESSION_ID: "s2",
      COMMAND_CODE_PARENT_SESSION: "p2",
      CMD_LOCAL_ONLY: "1",
      CMD_ZDR: "1",
      COMMAND_CODE_TELEMETRY_CONSOLE: "1",
    },
    [],
  );
  for (const k of ["CMD_SESSION_ID", "CMD_PARENT_SESSION", "COMMAND_CODE_SESSION_ID", "COMMAND_CODE_PARENT_SESSION"]) {
    expect(out[k]).toBeUndefined();
  }
  expect(out.CMD_LOCAL_ONLY).toBe("1");
  expect(out.CMD_ZDR).toBe("1");
  expect(out.COMMAND_CODE_TELEMETRY_CONSOLE).toBe("1");
});

// ---- harness env (config.yaml) ----------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "childenv-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Spec = Parameters<typeof runCli>[4];

/** Runs `sh -c script` through runCli and returns its stdout lines. */
async function runSh(script: string, spec: Partial<Spec> = {}, bin = "sh"): Promise<string[]> {
  const run = runCli(bin, ["-c", script], (line) => ({ text: line }), new AbortController().signal, {
    cwd: tmp,
    stdin: "",
    apiKeyVars: [],
    ...spec,
  });
  const lines: string[] = [];
  for await (const e of run.events) if (e.text !== undefined) lines.push(e.text);
  await run.finish();
  return lines;
}

test("resolveEnv returns plain text as is and reads {file} values trimmed, expanding ~", () => {
  const f = join(tmp, "tok");
  writeFileSync(f, "  file-value\n");
  expect(resolveEnv({ A: "text", B: { file: f } })).toEqual({ A: "text", B: "file-value" });
  // ~ expands to the home directory (the file does not exist, so the error shows the expanded path)
  expect(() => resolveEnv({ C: { file: "~/no-such-file-xyz" } })).toThrow(join(homedir(), "no-such-file-xyz"));
});

test("a harness env var reaches the child and wins over the inherited one; the parent env is untouched", async () => {
  Bun.env.AA_TEST_VAR = "inherited";
  try {
    expect(await runSh('echo "$AA_TEST_VAR"')).toEqual(["inherited"]);
    expect(await runSh('echo "$AA_TEST_VAR"', { env: { AA_TEST_VAR: "harness" } })).toEqual(["harness"]);
    expect(Bun.env.AA_TEST_VAR).toBe("inherited");
  } finally {
    delete Bun.env.AA_TEST_VAR;
  }
});

test("a harness env var survives the API-key strip because it was named explicitly", async () => {
  const out = await runSh('echo "$ANTHROPIC_API_KEY"', { apiKeyVars: ["ANTHROPIC_API_KEY"], env: { ANTHROPIC_API_KEY: "mine" } });
  expect(out).toEqual(["mine"]);
});

test("a {file} value is read at spawn time, not at boot", async () => {
  const f = join(tmp, "rotating");
  writeFileSync(f, "first\n");
  const env = { AA_TEST_TOK: { file: f } };
  expect(await runSh('echo "$AA_TEST_TOK"', { env })).toEqual(["first"]);
  writeFileSync(f, "second\n");
  expect(await runSh('echo "$AA_TEST_TOK"', { env })).toEqual(["second"]);
});

test("spec.bin overrides the binary", async () => {
  expect(await runSh("echo hi", { bin: "sh" }, "definitely-not-a-binary")).toEqual(["hi"]);
});

test("an unreadable or missing env file throws an error naming the variable and path, never a value", () => {
  const secret = "SUPER-SECRET-VALUE";
  const missing = join(tmp, "missing-file");
  expect(() => resolveEnv({ AA_TOK: { file: missing }, OTHER: secret })).toThrow(/AA_TOK/);
  expect(() => resolveEnv({ AA_TOK: { file: missing } })).toThrow(missing);

  const locked = join(tmp, "locked");
  writeFileSync(locked, secret);
  chmodSync(locked, 0o000);
  let message = "";
  try {
    resolveEnv({ AA_TOK: { file: locked }, OTHER: secret });
  } catch (err) {
    message = (err as Error).message;
  }
  chmodSync(locked, 0o600);
  expect(message).toContain("AA_TOK");
  expect(message).toContain(locked);
  expect(message).not.toContain(secret);
});

test("an empty env file is an error, thrown by runCli before spawning, after cleanup runs", () => {
  const empty = join(tmp, "empty");
  writeFileSync(empty, " \n");
  expect(() => resolveEnv({ AA_TOK: { file: empty } })).toThrow(/AA_TOK.*empty/);
  let cleaned = false;
  expect(() =>
    runCli("sh", ["-c", "true"], () => null, new AbortController().signal, {
      cwd: tmp,
      stdin: "",
      apiKeyVars: [],
      env: { AA_TOK: { file: empty } },
      cleanup: () => {
        cleaned = true;
      },
    }),
  ).toThrow(/AA_TOK/);
  expect(cleaned).toBe(true);
});
