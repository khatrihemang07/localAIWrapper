import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots the real server on a spare port and reads its LISTEN address with lsof,
// so the test checks what the OS actually bound, not what the code says.
const REPO_DIR = join(import.meta.dir, "..");
// Run from an empty folder: Bun loads a .env from the working directory, and a machine that
// sets HOST in the repo's .env must not change what "HOST unset" means here.
const RUN_DIR = mkdtempSync(join(tmpdir(), "wrapper-host-test-"));

const NON_LOOPBACK_WARNING = "no authentication";

async function boot(port: number, host?: string): Promise<{ address: string; output: string }> {
  const env: Record<string, string> = { ...(Bun.env as Record<string, string>), PORT: String(port) };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;

  const server = Bun.spawn(["bun", "run", join(REPO_DIR, "src/server.ts")], {
    cwd: RUN_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Wait for the startup line, which is printed only after Bun.serve has bound.
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (!out.includes("listening on")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited before listening: ${out}`);
      out += decoder.decode(value);
    }
    const lsof = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
    const names = new TextDecoder().decode(lsof.stdout).split("\n").filter((l) => l.startsWith("n"));
    expect(names.length).toBe(1);
    const address = names[0].slice(1); // e.g. "127.0.0.1:8097" or "*:8098"

    // The warning is printed right after the listen line, so stop the server and read
    // everything it wrote to either stream.
    server.kill();
    await server.exited;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value);
    }
    const err = await new Response(server.stderr).text();
    return { address, output: out + err };
  } finally {
    server.kill();
    await server.exited;
  }
}

async function listenAddress(port: number, host?: string): Promise<string> {
  return (await boot(port, host)).address;
}

test("with HOST unset the server listens on loopback only", async () => {
  expect(await listenAddress(8097)).toBe("127.0.0.1:8097");
});

test("HOST=0.0.0.0 makes the server listen on all interfaces", async () => {
  expect(await listenAddress(8098, "0.0.0.0")).toBe("*:8098");
});

test("HOST=0.0.0.0 logs a warning that the server has no authentication and is exposed to the network", async () => {
  const { output } = await boot(8099, "0.0.0.0");
  expect(output).toContain(NON_LOOPBACK_WARNING);
  expect(output).toContain("network");
});

test("HOST unset does not log the non-loopback warning", async () => {
  const { output } = await boot(8100);
  expect(output).not.toContain(NON_LOOPBACK_WARNING);
});

test("HOST=127.0.0.1 does not log the non-loopback warning", async () => {
  const { output } = await boot(8101, "127.0.0.1");
  expect(output).not.toContain(NON_LOOPBACK_WARNING);
});
