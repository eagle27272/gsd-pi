// Project/App: gsd-pi
// File Purpose: Resolve the authoritative milestone validation verdict from SQLite.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { getLatestAssessmentByScope, isDbAvailable } from "./gsd-db.js";
import { parseFrontmatterMap, splitFrontmatter } from "../shared/frontmatter.js";
import {
  isValidMilestoneVerdict,
  type ValidationVerdict,
} from "./verdict-parser.js";

export interface MilestoneValidationStatus {
  verdict: ValidationVerdict;
  remediationRound: number | null;
  validationPath: string | null;
  validationFileUnavailable?: true;
}

export function formatMilestoneValidationSummary(status: MilestoneValidationStatus): string {
  const round = status.remediationRound === null
    ? "round unavailable"
    : `round ${status.remediationRound}`;
  return `${status.verdict} (${round})`;
}

function isValidationFileUnavailable(path: string): boolean {
  try {
    return !statSync(path).isFile();
  } catch (error) {
    if (
      error instanceof Error && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR"
        || error.code === "EACCES" || error.code === "EPERM"
        || error.code === "EINVAL" || error.code === "ENAMETOOLONG"
        || error.code === "ELOOP" || error.code === "ERR_INVALID_ARG_VALUE")
    ) {
      return true;
    }
    throw error;
  }
}

/**
 * Read the validation summary from the same authoritative assessment as the
 * lifecycle verdict. The Markdown file is only a projection of this record.
 */
export function readMilestoneValidationStatus(
  milestoneId: string,
): MilestoneValidationStatus | undefined {
  if (!isDbAvailable()) return undefined;
  const assessment = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  const verdict = assessment?.status;
  if (typeof verdict !== "string" || !isValidMilestoneVerdict(verdict)) return undefined;

  const validationPath = typeof assessment?.path === "string" && assessment.path.trim()
    ? assessment.path
    : null;

  const content = typeof assessment?.full_content === "string" ? assessment.full_content : "";
  const [frontmatter] = splitFrontmatter(content);
  const rawRound = frontmatter ? parseFrontmatterMap(frontmatter).remediation_round : undefined;
  const round = typeof rawRound === "string" && /^\d+$/.test(rawRound)
    ? Number(rawRound)
    : NaN;

  return {
    verdict,
    remediationRound: Number.isSafeInteger(round) ? round : null,
    validationPath,
    ...(validationPath && isAbsolute(validationPath) && isValidationFileUnavailable(validationPath)
      ? { validationFileUnavailable: true as const }
      : {}),
  };
}

/**
 * Resolve the current database verdict. VALIDATION.md is a projection and can
 * only enter authority through an explicit import operation.
 */
export function readMilestoneValidationVerdict(
  milestoneId: string,
): ValidationVerdict | undefined {
  if (!isDbAvailable()) return undefined;
  const assessment = getLatestAssessmentByScope(milestoneId, "milestone-validation");
  const status = typeof assessment?.status === "string" ? assessment.status : undefined;
  return status && isValidMilestoneVerdict(status) ? status : undefined;
}

export async function resolveMilestoneValidationVerdict(
  _basePath: string,
  milestoneId: string,
): Promise<ValidationVerdict | undefined> {
  return readMilestoneValidationVerdict(milestoneId);
}
