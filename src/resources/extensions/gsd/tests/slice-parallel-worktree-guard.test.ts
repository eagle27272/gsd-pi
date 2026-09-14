// Project/App: gsd-pi
// File Purpose: Regression tests for the containment guards protecting the
// rmSync in slice worktree creation (issue #21).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSliceWorktree } from "../slice-parallel-orchestrator.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function catchError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

function plantVictim(base: string, name: string): string {
  const victim = join(base, name);
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "keep.txt"), "precious\n");
  return victim;
}

test("createSliceWorktree refuses a milestoneId that escapes the worktrees container", () => {
  const base = makeTempRepo("gsd-slice-wt-guard-");
  try {
    mkdirSync(join(base, ".gsd-worktrees"), { recursive: true });
    const victim = plantVictim(base, "victim-S01");

    const thrown = catchError(() => createSliceWorktree(base, "../victim", "S01"));

    assert.equal(readFileSync(join(victim, "keep.txt"), "utf-8"), "precious\n");
    assert.match(thrown, /Invalid milestoneId/);
  } finally {
    cleanup(base);
  }
});

test("createSliceWorktree refuses a sliceId that escapes the worktrees container", () => {
  const base = makeTempRepo("gsd-slice-wt-guard-");
  try {
    mkdirSync(join(base, ".gsd-worktrees"), { recursive: true });
    const victim = plantVictim(base, "victim2");

    const thrown = catchError(() => createSliceWorktree(base, "M001", "../../../victim2"));

    assert.equal(readFileSync(join(victim, "keep.txt"), "utf-8"), "precious\n");
    assert.match(thrown, /Invalid sliceId/);
  } finally {
    cleanup(base);
  }
});

test("createSliceWorktree refuses identifiers containing a path separator", () => {
  const base = makeTempRepo("gsd-slice-wt-guard-");
  try {
    assert.throws(() => createSliceWorktree(base, "M001/S01", "S01"), /Invalid milestoneId/);
    assert.throws(() => createSliceWorktree(base, "M001", "a/b"), /Invalid sliceId/);
  } finally {
    cleanup(base);
  }
});

test("createSliceWorktree refuses empty identifiers", () => {
  const base = makeTempRepo("gsd-slice-wt-guard-");
  try {
    assert.throws(() => createSliceWorktree(base, "", "S01"), /Invalid milestoneId/);
    assert.throws(() => createSliceWorktree(base, "M001", ""), /Invalid sliceId/);
  } finally {
    cleanup(base);
  }
});

test("createSliceWorktree still clears a stale non-worktree directory inside the container", () => {
  const base = makeTempRepo("gsd-slice-wt-guard-");
  try {
    const stale = join(base, ".gsd-worktrees", "M001-S01");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "leftover.txt"), "stale\n");

    // The post-create hook / .gsd sync that follows needs more fixture setup
    // than this guard test provides; what matters here is that the legitimate
    // in-container cleanup still runs and git creates the worktree.
    try {
      createSliceWorktree(base, "M001", "S01");
    } catch {
      /* later stages are out of scope for this test */
    }

    assert.equal(existsSync(join(stale, "leftover.txt")), false);
    assert.equal(existsSync(join(stale, ".git")), true);
  } finally {
    cleanup(base);
  }
});
