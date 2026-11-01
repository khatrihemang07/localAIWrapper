import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots the real server with TOOL_EMULATION unset and checks the 400s a client sees
// for tool-calling requests. Runs from an empty folder so a machine .env cannot
// turn emulation on for this test.
const REPO_DIR = join(import.meta.dir, "..");
const RUN_DIR = mkdtempSync(join(tmpdir(), "wrapper-toolemu-off-test-"));
const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}/v1/chat/completions`;

let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  const env: Record<string, string> = { ...(Bun.env as Record<string, string>), PORT: String(PORT) };
  delete env.TOOL_EMULATION;
  delete env.HOST;
  server = Bun.spawn(["bun", "run", join(REPO_DIR, "src/server.ts")], { cwd: RUN_DIR, env, stdout: "pipe", stderr: "pipe" });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("listening on")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before listening: ${out}`);
    out += decoder.decode(value);
  }
  reader.releaseLock();
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
});

const tools = [{ type: "function", function: { name: "ask_user", parameters: { type: "object", properties: {} } } }];

async function post(body: unknown): Promise<{ status: number; message: string }> {
  const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { error: { message: string } };
  return { status: res.status, message: json.error.message };
}

test("with TOOL_EMULATION unset, a valid request with tools is rejected as unsupported", async () => {
  const r = await post({ model: "any-model", tools, messages: [{ role: "user", content: "hi" }] });
  expect(r.status).toBe(400);
  expect(r.message).toContain("does not support tool calling");
});

test("with TOOL_EMULATION unset, tools plus only a system message gets the messages error", async () => {
  const r = await post({ model: "any-model", tools, messages: [{ role: "system", content: "sys" }] });
  expect(r.status).toBe(400);
  expect(r.message).toBe('"messages" must include at least one "user" or "assistant" message');
});
