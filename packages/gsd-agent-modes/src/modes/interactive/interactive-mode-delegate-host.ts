/**
 * Host surface for the interactive-mode delegate modules.
 *
 * Derived from the class rather than restated as an interface, so the contract
 * cannot drift from what InteractiveMode actually exposes. The import is
 * type-only and erased at emit, so the delegate -> host -> mode cycle carries
 * no runtime edge.
 */
import type { InteractiveMode } from "./interactive-mode.js";

export type InteractiveModeDelegateHost = InteractiveMode;
