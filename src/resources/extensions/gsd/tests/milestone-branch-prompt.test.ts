// gsd-pi — Asking for a milestone branch name: config display, TUI prompt, discuss question.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatConfigText } from "../config-overlay.ts";
import { makeRepo, removeRepo } from "./milestone-branch-fixture.ts";

function writeGitPrefs(repo: string, lines: string[]): void {
  writeFileSync(join(repo, ".gsd", "PREFERENCES.md"), ["---", "git:", ...lines.map((l) => `  ${l}`), "---", ""].join("\n"));
}

describe("milestone branch preference display", () => {
  let repo: string;
  let gsdHome: string;
  let previousGsdHome: string | undefined;

  beforeEach(() => {
    repo = makeRepo("gsd-ms-branch-prompt-");
    gsdHome = mkdtempSync(join(tmpdir(), "gsd-ms-branch-home-"));
    previousGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdHome;
  });

  afterEach(() => {
    if (previousGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousGsdHome;
    rmSync(gsdHome, { recursive: true, force: true });
    removeRepo(repo);
  });

  test("the config overlay shows the milestone branch format", () => {
    writeGitPrefs(repo, ["milestone_branch_format: \"<change-type>/<short_snake_case_summary>\""]);
    const text = formatConfigText({ basePath: repo });
    assert.match(text, /Milestone branch format/);
    assert.match(text, /<change-type>\/<short_snake_case_summary>/);
  });
});
