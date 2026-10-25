// Resolves a request's `workdir` against the configured allowlist of roots.
//
// The check runs on realpaths, so both `..` segments and symlinks are resolved
// before the containment test: a path that textually starts inside a root but
// lands outside it after resolution is rejected. Roots are expected to be
// realpaths already (see config.ts), so the comparison is like-for-like.

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export type WorkdirResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * One message for every rejection that depends on the filesystem: outside the
 * roots, nonexistent, or not a directory. Distinct messages would let a client
 * probe which paths exist outside the allowlist.
 */
const NOT_ALLOWED = `"workdir" is not an allowed directory`;

export function resolveWorkdir(requested: string, roots: readonly string[]): WorkdirResult {
  // Relative paths reveal nothing about the filesystem, so they keep their own message.
  if (!isAbsolute(requested)) {
    return { ok: false, message: `"workdir" must be an absolute path` };
  }

  // Containment is decided on the realpath first. A nonexistent path cannot be
  // resolved, so it fails the same way as one that resolves outside the roots.
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    return { ok: false, message: NOT_ALLOWED };
  }

  const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep));
  if (!inside) {
    return { ok: false, message: NOT_ALLOWED };
  }

  if (!statSync(real).isDirectory()) {
    return { ok: false, message: NOT_ALLOWED };
  }

  return { ok: true, path: real };
}
