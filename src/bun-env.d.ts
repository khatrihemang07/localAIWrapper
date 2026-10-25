// Minimal ambient declarations for the handful of Bun globals this project
// uses (Bun.serve, Bun.spawn). Hand-rolled instead of installing the
// `bun-types` package so that no third-party dependency is required to
// typecheck or run this project (see project constraint: zero dependencies).

declare namespace Bun {
  const env: Record<string, string | undefined>;

  interface ServeOptions {
    hostname?: string;
    port?: number;
    /** Seconds a connection may go without a byte before Bun closes it. Bun's own default is 10 and its maximum is 255. */
    idleTimeout?: number;
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

// The few Node built-ins this project imports (config, workdir resolution,
// temp files for codex's output schema). Declared by hand for the same reason
// as the Bun globals above: no @types/node dependency.
declare module "node:fs" {
  export function realpathSync(path: string): string;
  export function statSync(path: string): { isDirectory(): boolean };
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}
