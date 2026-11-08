import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boots the real server on a free port and reads its LISTEN address with lsof,
// so the test checks what the OS actually bound, not what the code says.
const REPO_DIR = join(import.meta.dir, "..");
// Run from an empty folder: Bun loads a .env from the working directory, and a machine that
// sets HOST in the repo's .env must not change what "HOST unset" means here.
const RUN_DIR = mkdtempSync(join(tmpdir(), "wrapper-host-test-"));

const NON_LOOPBACK_WARNING = "no authentication";
const LISTEN_LINE = "listening on";
const WAIT_MS = 5000;

// Asks the OS for a port that is free right now: Bun picks one, and we release it
// before the server under test binds it.
function freePort(hostname: string): number {
  const probe = Bun.serve({ port: 0, hostname, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${WAIT_MS}ms waiting for ${what}`);
    await Bun.sleep(20);
  }
}

interface Running {
  address: string;
  // Everything the server wrote to stdout and stderr, in the order it was written.
  output(): string;
  // Only the output written before the listen line.
  outputBeforeListen: string;
  stop(): Promise<void>;
}

async function start(port: number, host?: string): Promise<Running> {
  const env: Record<string, string> = { ...(Bun.env as Record<string, string>), PORT: String(port) };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;

  // 2>&1 merges stderr into stdout through one pipe, so the order of lines is the order the
  // process wrote them.
  const server = Bun.spawn(["sh", "-c", `exec bun run "${join(REPO_DIR, "src/server.ts")}" 2>&1`], {
    cwd: RUN_DIR,
    env,
    stdout: "pipe",
    stderr: "ignore",
  });
  let out = "";
  let exited = false;
  server.exited.then(() => (exited = true));
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of server.stdout) out += decoder.decode(chunk, { stream: true });
  })();
  const stop = async () => {
    server.kill();
    await server.exited;
    await reading;
  };

  try {
    await waitFor(() => out.includes(LISTEN_LINE) || exited, "the listen line");
    if (!out.includes(LISTEN_LINE)) throw new Error(`server exited before listening: ${out}`);
    const outputBeforeListen = out.slice(0, out.indexOf(LISTEN_LINE));

    const lsof = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"]);
    const names = new TextDecoder().decode(lsof.stdout).split("\n").filter((l) => l.startsWith("n"));
    expect(names.length).toBe(1);
    const address = names[0].slice(1); // e.g. "127.0.0.1:8097" or "*:8098"

    return { address, output: () => out, outputBeforeListen, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

async function listenAddress(port: number, host?: string): Promise<string> {
  const run = await start(port, host);
  try {
    return run.address;
  } finally {
    await run.stop();
  }
}

test("with HOST unset the server listens on loopback only", async () => {
  const port = freePort("127.0.0.1");
  expect(await listenAddress(port)).toBe(`127.0.0.1:${port}`);
});

test("HOST=0.0.0.0 makes the server listen on all interfaces", async () => {
  const port = freePort("0.0.0.0");
  expect(await listenAddress(port, "0.0.0.0")).toBe(`*:${port}`);
});

test("HOST=0.0.0.0 logs a warning that the server has no authentication and is exposed to the network", async () => {
  const run = await start(freePort("0.0.0.0"), "0.0.0.0");
  try {
    await waitFor(() => run.output().includes(NON_LOOPBACK_WARNING), "the non-loopback warning");
    expect(run.output()).toContain("network");
  } finally {
    await run.stop();
  }
});

test("HOST=0.0.0.0 prints the warning before the server binds, not after the listen line", async () => {
  const run = await start(freePort("0.0.0.0"), "0.0.0.0");
  try {
    expect(run.outputBeforeListen).toContain(NON_LOOPBACK_WARNING);
  } finally {
    await run.stop();
  }
});

test("HOST unset does not log the non-loopback warning", async () => {
  const run = await start(freePort("127.0.0.1"));
  try {
    expect(run.output()).not.toContain(NON_LOOPBACK_WARNING);
  } finally {
    await run.stop();
  }
});

test("HOST=127.0.0.1 does not log the non-loopback warning", async () => {
  const run = await start(freePort("127.0.0.1"), "127.0.0.1");
  try {
    expect(run.output()).not.toContain(NON_LOOPBACK_WARNING);
  } finally {
    await run.stop();
  }
});

test("HOST=LOCALHOST and HOST=[::1] do not log the non-loopback warning", async () => {
  for (const host of ["LOCALHOST", "[::1]"]) {
    const run = await start(freePort("127.0.0.1"), host);
    try {
      expect(run.output()).not.toContain(NON_LOOPBACK_WARNING);
    } finally {
      await run.stop();
    }
  }
});
