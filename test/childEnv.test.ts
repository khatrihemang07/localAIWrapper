import { expect, test } from "bun:test";
import { childEnvironment } from "../src/backends/cli.ts";
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
