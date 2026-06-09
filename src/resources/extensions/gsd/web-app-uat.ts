// Project/App: gsd-pi
// File Purpose: Web-app detection and Playwright/UAT guidance for planning and slice closeout.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { detectWebApp } from "../browser-tools/web-app-detect.js";

export { detectWebApp };

interface MinimalPackageJson {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
}

function readPackageJson(projectRoot: string): MinimalPackageJson | null {
  const packageJsonPath = resolve(projectRoot, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as MinimalPackageJson) : null;
  } catch {
    return null;
  }
}

export function hasPlaywrightTestDependency(projectRoot: string): boolean {
  const pkg = readPackageJson(projectRoot);
  if (!pkg) return false;
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  return names.some((name) => name === "playwright" || name === "@playwright/test");
}

export function findPlaywrightTestScript(projectRoot: string): string | null {
  const pkg = readPackageJson(projectRoot);
  if (!pkg?.scripts) return null;
  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (typeof value !== "string") continue;
    if (/\bplaywright\s+test\b/.test(value)) {
      return `npm run ${name}`;
    }
  }
  return null;
}

/**
 * Markdown block injected into plan/complete-slice prompts when the project
 * looks browser-facing. Returns null for CLI/library-only repos.
 */
export function buildWebAppUatGuidanceBlock(projectRoot: string): string | null {
  if (!detectWebApp(projectRoot)) return null;

  const playwrightScript = findPlaywrightTestScript(projectRoot);
  const hasPlaywright = hasPlaywrightTestDependency(projectRoot) || playwrightScript !== null;
  const lines = [
    "### Web App UAT (detected)",
    "",
    "This project looks browser-facing. GSD exposes Playwright-backed `browser_*` tools by default for run-uat.",
    "",
    "**UAT modes (pick one per slice — do not use `artifact-driven` for browser steps):**",
    "- `browser-executable` — navigate to `http://localhost:…`, click, screenshot, assert via `browser_*` tools during run-uat",
    "- `runtime-executable` — run an automated browser test command via `gsd_uat_exec` (for example `npx playwright test`)",
    "- `mixed` / `live-runtime` — combine runtime startup checks with interactive browser verification",
    "",
    "**Planning / closeout rules:**",
    "- Preconditions must name the dev-server command and URL (for example `npm run dev` → `http://localhost:3000`)",
    "- Slice Verification and UAT test cases must not say \"open in browser\" under `artifact-driven` — complete-slice rejects that",
    "- Milestone `Verification Classes` → UAT row must describe browser-observable acceptance, not \"manual spot check\" alone",
  ];

  if (hasPlaywright) {
    lines.push(
      "",
      "**Playwright:** dependency detected.",
    );
    if (playwrightScript) {
      lines.push(
        `- Prefer slice verification and runtime-executable UAT referencing \`${playwrightScript}\` or a focused \`npx playwright test <spec>\` command`,
      );
    } else {
      lines.push(
        "- Prefer runtime-executable UAT with `npx playwright test` (or a focused spec path) when UI behavior is covered by specs",
      );
    }
    lines.push("- Name concrete spec paths in slice Verification (for example `e2e/smoke.spec.ts`)");
  } else {
    lines.push(
      "",
      "**Playwright scaffolding (first UI slice):** no `playwright` / `@playwright/test` dependency yet.",
      "- Add a planning task that installs Playwright, adds `playwright.config.ts`, and creates a minimal smoke spec (for example `e2e/smoke.spec.ts`)",
      "- Task `verify` should run `npx playwright test` (or the focused spec) with a safe, simple command",
      "- Until specs exist, use `browser-executable` UAT with localhost preconditions and interactive `browser_*` checks at slice closeout",
    );
  }

  return lines.join("\n");
}
