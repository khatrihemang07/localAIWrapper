// Minimal ambient declarations for the handful of Bun globals this project
// uses (Bun.serve, Bun.spawn). Hand-rolled instead of installing the
// `bun-types` package so that no third-party dependency is required to
// typecheck or run this project (see project constraint: zero dependencies).

declare namespace Bun {
  const env: Record<string, string | undefined>;

  interface ServeOptions {
    hostname?: string;
    port?: number;
    fetch(req: Request): Response | Promise<Response>;
  }

  interface Server {
    stop(closeActiveConnections?: boolean): void;
    readonly port: number;
    readonly hostname: string;
  }

  function serve(options: ServeOptions): Server;

  type StdioOption = "pipe" | "inherit" | "ignore";

  interface SpawnOptions {
    stdout?: StdioOption;
    stderr?: StdioOption;
    stdin?: StdioOption;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }

  interface Subprocess {
    readonly pid: number;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<number>;
    kill(signal?: number | string): void;
  }

  function spawn(cmd: string[], options?: SpawnOptions): Subprocess;
}
