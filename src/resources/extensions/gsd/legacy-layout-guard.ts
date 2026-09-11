// Project/App: gsd-pi
// File Purpose: Fails closed when a project still uses a pre-migration on-disk layout.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LEGACY_MILESTONE_RUNTIME_DIRS = new Set(["anchors"]);
const LAST_MIGRATING_VERSION = "v1.18.0";

export type LegacyLayoutFinding = {
  kind: "milestones-layout";
  path: string;
};

function isContentBearingMilestone(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      if (!/-META\.json$/i.test(entry.name)) return true;
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (LEGACY_MILESTONE_RUNTIME_DIRS.has(entry.name)) continue;
    try {
      if (readdirSync(join(dir, entry.name)).length > 0) return true;
    } catch {
      // Unreadable subdirectory proves nothing; keep scanning.
    }
  }
  return false;
}

export function detectLegacyLayout(basePath: string): LegacyLayoutFinding | null {
  const gsd = join(basePath, ".gsd");

  const milestones = join(gsd, "milestones");
  if (existsSync(milestones)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(milestones);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const candidate = join(milestones, entry);
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      if (isContentBearingMilestone(candidate)) {
        return { kind: "milestones-layout", path: candidate };
      }
    }
  }

  return null;
}

const REMEDIES: Record<LegacyLayoutFinding["kind"], string> = {
  "milestones-layout":
    "This project uses the pre-flat-phase milestones/<MID>/ layout.",
};

export function assertNoLegacyLayout(basePath: string): void {
  const finding = detectLegacyLayout(basePath);
  if (!finding) return;
  throw new Error(
    `${REMEDIES[finding.kind]}\n` +
      `  Found: ${finding.path}\n` +
      `  Support for migrating this layout was removed. ` +
      `GSD ${LAST_MIGRATING_VERSION} is the last version that can convert it.`,
  );
}
