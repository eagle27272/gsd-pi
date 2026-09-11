// Project/App: gsd-pi
// File Purpose: Canonical path normalization shared by the path contract and
// the compat marker.
//
// Leaf module by design: `paths.ts` and `compat/compat-marker.ts` both need a
// notion of "canonical form", and a second private copy is how the two drifted
// apart (#3).

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve a path to its canonical real path using the native resolver.
 * On macOS case-insensitive (HFS+/APFS) volumes, realpathSync.native normalizes
 * case — ensuring that /foo/Bar and /foo/bar resolve to the same string.
 * Falls back to resolve(p) for non-existent paths.
 *
 * Use this helper everywhere a path is used as an identity/cache key so that
 * all callers agree on the canonical form.
 */
export function normalizeRealPath(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/**
 * Canonicalize a path that may not exist yet, by realpath-normalizing its
 * longest existing ancestor and re-attaching the missing tail.
 *
 * Only for paths being compared against an already-realpath'd root. Plain
 * `normalizeRealPath` leaves a not-yet-written file in whatever namespace the
 * caller built it from, so a file under a symlinked `.gsd` compares against the
 * store's realpath as if it were somewhere else entirely — and `relative()`
 * then yields a `../`-escaping key instead of a projection-relative one (#3).
 *
 * Not a drop-in for `normalizeRealPath`: for a purely hypothetical path it
 * rewrites whatever prefix happens to exist on this machine, which is wrong for
 * callers doing pure path arithmetic.
 */
export function normalizeRealPathForComparison(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    // Falls through to the ancestor walk below.
  }

  const missingTail: string[] = [];
  let cursor = abs;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) return abs;
    missingTail.unshift(basename(cursor));
    try {
      return join(realpathSync.native(parent), ...missingTail);
    } catch {
      cursor = parent;
    }
  }
}
