// gsd-pi — The three milestone-discussion prompts carry the branch question.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPrompt } from "../prompt-loader.ts";

const SENTINEL = "## Milestone Branch Name\nBRANCH-QUESTION-SENTINEL";

const cases: Array<[string, Record<string, string>]> = [
  [
    "discuss",
    {
      milestoneId: "M001",
      preamble: "Preamble.",
      preparationContext: "",
      structuredQuestionsAvailable: "true",
      contextPath: ".gsd/milestones/M001/M001-CONTEXT.md",
      roadmapPath: ".gsd/milestones/M001/M001-ROADMAP.md",
      inlinedTemplates: "## Templates",
      commitInstruction: "Do not commit.",
      multiMilestoneCommitInstruction: "Do not commit.",
    },
  ],
  [
    "guided-discuss-milestone",
    {
      workingDirectory: process.cwd(),
      milestoneId: "M001",
      milestoneTitle: "Auth",
      structuredQuestionsAvailable: "true",
      fastPathInstruction: "No fast path.",
      inlinedTemplates: "## Context",
      commitInstruction: "Do not commit.",
    },
  ],
  [
    "queue",
    {
      preamble: "Queue preamble.",
      existingMilestonesContext: "No existing milestones.",
      inlinedTemplates: "## Context Template",
      commitInstruction: "Do not commit.",
    },
  ],
];

for (const [name, vars] of cases) {
  test(`${name} renders the branch question block`, () => {
    const prompt = loadPrompt(name, { ...vars, milestoneBranchQuestion: SENTINEL });
    assert.ok(prompt.includes("BRANCH-QUESTION-SENTINEL"), `${name} includes {{milestoneBranchQuestion}}`);
    assert.doesNotMatch(prompt, /\{\{milestoneBranchQuestion\}\}/);
  });

  test(`${name} renders cleanly when the branch question is empty`, () => {
    const prompt = loadPrompt(name, { ...vars, milestoneBranchQuestion: "" });
    assert.doesNotMatch(prompt, /Milestone Branch Name/);
  });
}
