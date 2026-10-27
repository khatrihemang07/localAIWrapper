import { expect, test } from "bun:test";
import { join } from "node:path";

// Boots the real server on a spare port and reads its LISTEN address with lsof,
// so the test checks what the OS actually bound, not what the code says.
const REPO_DIR = join(import.meta.dir, "..");

async function listenAddress(port: number, host?: string): Promise<string> {
  const env: Record<string, string> = { ...(Bun.env as Record<string, string>), PORT: String(port) };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;

  const server = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: REPO_DIR,
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
    reader.releaseLock();

    const lsof = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
    const names = new TextDecoder().decode(lsof.stdout).split("\n").filter((l) => l.startsWith("n"));
    expect(names.length).toBe(1);
    return names[0].slice(1); // e.g. "127.0.0.1:8097" or "*:8098"
  } finally {
    server.kill();
    await server.exited;
  }
}

test("with HOST unset the server listens on loopback only", async () => {
  expect(await listenAddress(8097)).toBe("127.0.0.1:8097");
});

test("HOST=0.0.0.0 makes the server listen on all interfaces", async () => {
  expect(await listenAddress(8098, "0.0.0.0")).toBe("*:8098");
});
