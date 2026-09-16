import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEGRAPH_DISABLED_ENV,
  CODEGRAPH_PATH_ENV,
  detectCodegraph,
  findIndexRoot,
  hasIndex,
  resolveBinary,
} from "../detect.ts";

const HOME = "/Users/dev";

/** Treats every path in `dirs` as an existing directory, everything else as absent. */
function fakeDirs(dirs: string[]): (path: string) => boolean {
  const set = new Set(dirs);
  return (path) => set.has(path);
}

/** Treats every path in `bins` as an executable file. */
function fakeBins(bins: string[]): (path: string) => boolean {
  const set = new Set(bins);
  return (path) => set.has(path);
}

test("findIndexRoot returns the directory holding .codegraph", () => {
  const isDirectory = fakeDirs(["/Users/dev/proj/.codegraph"]);
  assert.equal(findIndexRoot("/Users/dev/proj", { home: HOME, isDirectory }), "/Users/dev/proj");
});

test("findIndexRoot walks up to a parent that holds the index", () => {
  const isDirectory = fakeDirs(["/Users/dev/proj/.codegraph"]);
  assert.equal(
    findIndexRoot("/Users/dev/proj/src/deep/nested", { home: HOME, isDirectory }),
    "/Users/dev/proj",
  );
});

test("findIndexRoot never matches ~/.codegraph, which is CodeGraph's global state dir", () => {
  // CodeGraph stores daemon records and telemetry in ~/.codegraph. Testing $HOME
  // itself would report every project under the home directory as indexed.
  const isDirectory = fakeDirs(["/Users/dev/.codegraph"]);
  assert.equal(findIndexRoot("/Users/dev/proj/src", { home: HOME, isDirectory }), null);
});

test("findIndexRoot returns null at the filesystem root when nothing is indexed", () => {
  assert.equal(findIndexRoot("/srv/app", { home: HOME, isDirectory: fakeDirs([]) }), null);
});

test("findIndexRoot does not consult the git common dir for an unindexed worktree", () => {
  // The main checkout is indexed; the worktree is not. A worktree session gets null.
  const isDirectory = fakeDirs(["/Users/dev/git/app/.codegraph"]);
  assert.equal(
    findIndexRoot("/Users/dev/.claude/worktrees/app/feature", { home: HOME, isDirectory }),
    null,
  );
});

test("hasIndex checks for .codegraph directly under the given root", () => {
  const isDirectory = fakeDirs(["/Users/dev/proj/.codegraph"]);
  assert.equal(hasIndex("/Users/dev/proj", isDirectory), true);
  assert.equal(hasIndex("/Users/dev/other", isDirectory), false);
});

test("resolveBinary finds codegraph on PATH", () => {
  const env = { PATH: "/usr/bin:/opt/homebrew/bin" } as NodeJS.ProcessEnv;
  const isExecutable = fakeBins(["/opt/homebrew/bin/codegraph"]);
  assert.equal(resolveBinary({ env, isExecutable }), "/opt/homebrew/bin/codegraph");
});

test("resolveBinary returns null when codegraph is not on PATH", () => {
  const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
  assert.equal(resolveBinary({ env, isExecutable: fakeBins([]) }), null);
});

test("resolveBinary honours the path override and rejects it when not executable", () => {
  const env = { PATH: "/usr/bin", [CODEGRAPH_PATH_ENV]: "/custom/cg" } as NodeJS.ProcessEnv;
  assert.equal(resolveBinary({ env, isExecutable: fakeBins(["/custom/cg"]) }), "/custom/cg");
  assert.equal(resolveBinary({ env, isExecutable: fakeBins(["/usr/bin/codegraph"]) }), null);
});

test("detectCodegraph returns the env when the index and binary are both present", () => {
  const result = detectCodegraph({
    cwd: "/Users/dev/proj/src",
    home: HOME,
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
    isExecutable: fakeBins(["/usr/bin/codegraph"]),
  });
  assert.deepEqual(result, { binPath: "/usr/bin/codegraph", projectRoot: "/Users/dev/proj" });
});

test("detectCodegraph returns null when the binary is missing", () => {
  assert.equal(
    detectCodegraph({
      cwd: "/Users/dev/proj",
      home: HOME,
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
      isExecutable: fakeBins([]),
    }),
    null,
  );
});

test("detectCodegraph returns null when the project has no index", () => {
  assert.equal(
    detectCodegraph({
      cwd: "/Users/dev/proj",
      home: HOME,
      env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      isDirectory: fakeDirs([]),
      isExecutable: fakeBins(["/usr/bin/codegraph"]),
    }),
    null,
  );
});

test("detectCodegraph returns null when disabled by env, even if everything else is present", () => {
  for (const value of ["1", "true", "yes"]) {
    assert.equal(
      detectCodegraph({
        cwd: "/Users/dev/proj",
        home: HOME,
        env: { PATH: "/usr/bin", [CODEGRAPH_DISABLED_ENV]: value } as NodeJS.ProcessEnv,
        isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
        isExecutable: fakeBins(["/usr/bin/codegraph"]),
      }),
      null,
      `expected ${value} to disable`,
    );
  }
});

test("detectCodegraph treats empty, '0' and 'false' as not disabled", () => {
  for (const value of ["", "0", "false"]) {
    assert.ok(
      detectCodegraph({
        cwd: "/Users/dev/proj",
        home: HOME,
        env: { PATH: "/usr/bin", [CODEGRAPH_DISABLED_ENV]: value } as NodeJS.ProcessEnv,
        isDirectory: fakeDirs(["/Users/dev/proj/.codegraph"]),
        isExecutable: fakeBins(["/usr/bin/codegraph"]),
      }),
      `expected ${JSON.stringify(value)} not to disable`,
    );
  }
});
