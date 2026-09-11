import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureExternalState } from "../external-state-bootstrap.ts";
import { _bootstrapGsdProjectForTest } from "../guided-flow.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

interface Fixture {
  repo: string;
  stateDir: string;
  cleanup: () => void;
}

function makeRepo(prefix: string): Fixture {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(tempRoot, "repo");
  const stateDir = join(tempRoot, "state");
  mkdirSync(repo);
  mkdirSync(stateDir);

  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["remote", "add", "origin", `https://example.invalid/${prefix}.git`]);
  writeFileSync(join(repo, "README.md"), "# Test\n", "utf-8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);

  const previousStateDir = process.env.GSD_STATE_DIR;
  process.env.GSD_STATE_DIR = stateDir;

  return {
    repo,
    stateDir,
    cleanup: () => {
      if (previousStateDir === undefined) delete process.env.GSD_STATE_DIR;
      else process.env.GSD_STATE_DIR = previousStateDir;
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function assertExternalized(repo: string, stateDir: string): string {
  const localGsd = join(repo, ".gsd");
  assert.equal(
    lstatSync(localGsd).isSymbolicLink(),
    true,
    ".gsd must be a symlink into the external state directory, not a real directory",
  );
  const target = realpathSync(localGsd);
  assert.equal(
    target.startsWith(realpathSync(join(stateDir, "projects"))),
    true,
    `.gsd should resolve under the external projects root, got ${target}`,
  );
  return target;
}

test("ensureExternalState symlinks a fresh project into external state", { skip: process.platform === "win32" }, () => {
  const { repo, stateDir, cleanup } = makeRepo("gsd-ext-fresh-");
  try {
    const result = ensureExternalState(repo);

    const target = assertExternalized(repo, stateDir);
    assert.equal(result.externalPath, target);
    assert.equal(result.migrationError, undefined);
  } finally {
    cleanup();
  }
});

test("ensureExternalState migrates an existing local .gsd directory", { skip: process.platform === "win32" }, () => {
  const { repo, stateDir, cleanup } = makeRepo("gsd-ext-migrate-");
  try {
    mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# local state\n", "utf-8");

    ensureExternalState(repo);

    const target = assertExternalized(repo, stateDir);
    assert.equal(readFileSync(join(target, "STATE.md"), "utf-8"), "# local state\n");
  } finally {
    cleanup();
  }
});

test("ensureExternalState writes the .gsd-id relocation marker", { skip: process.platform === "win32" }, () => {
  const { repo, cleanup } = makeRepo("gsd-ext-marker-");
  try {
    ensureExternalState(repo);
    assert.equal(readFileSync(join(repo, ".gsd-id"), "utf-8").trim().length > 0, true);
  } finally {
    cleanup();
  }
});

test("bootstrapGsdProject externalizes state instead of creating a local .gsd", { skip: process.platform === "win32" }, () => {
  const { repo, stateDir, cleanup } = makeRepo("gsd-bootstrap-guided-");
  try {
    _bootstrapGsdProjectForTest(repo);

    assertExternalized(repo, stateDir);
  } finally {
    cleanup();
  }
});
