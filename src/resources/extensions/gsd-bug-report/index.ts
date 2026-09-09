/**
 * gsd-pi Self-Report extension.
 *
 * Registers the `report_gsd_bug` tool, the `/report-gsd-bug` command, and a
 * session_start reset hook. Wiring is completed in later tasks.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export default function gsdBugReport(_pi: ExtensionAPI): void {
  // Registration added in Tasks 5–6.
}
