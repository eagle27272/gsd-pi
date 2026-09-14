# Typing the interactive-mode delegate seam

Resolves [#89](https://github.com/eagle27272/gsd-pi/issues/89).

## Problem

`InteractiveMode` lives in `packages/gsd-agent-modes/src/modes/interactive/interactive-mode.ts`.
During the Phase E2 seam remediation its implementation was extracted into sibling modules that
take the instance as a first argument and reach into it directly. Two escape hatches make that
compile:

- `interactive-mode-delegate-host.ts` declares `export type InteractiveModeDelegateHost = any;`
- 13 extracted modules carry `// @ts-nocheck`

The most stateful part of the TUI therefore gets no type checking at all. A renamed field, a typo
in a member name, or a changed signature all compile clean and fail at runtime.

The lint symptom is that `noUnusedLocals` cannot be enabled for the package: `InteractiveMode`'s
private fields are written and read exclusively from unchecked `any` code, so tsc reports 102 of
them as unused. They are not dead — deleting them breaks the TUI.

## Measurements

Taken on a fully built worktree. Every number below is observed, not estimated.

| Quantity | Value |
| --- | --- |
| `noUnusedLocals` errors for the package | 102, all TS6133, all in `interactive-mode.ts` |
| Split of those 102 | 66 private delegate-wrapper methods, 36 private fields |
| Of the 102, genuinely dead | 0 — all are reached via `host.<name>` from delegate modules |
| Files carrying `@ts-nocheck` | 13 |
| Distinct `host.<member>` surface across delegates | 159 |
| Errors once `@ts-nocheck` is removed, host still `any` | 116 |
| Errors once the host is typed *and* `@ts-nocheck` removed | 120 |
| Residual after deleting one duplicated import block | 62 |

The 102 were checked for liveness by matching only host-receiver references
(`host.foo`, `_host.foo`), so same-named module functions such as `chatRender.showStatus` do not
produce false positives.

### Residual 62

| Code | Count | Nature |
| --- | --- | --- |
| TS6133 | 47 | unused import or local |
| TS6196 | 6 | unused type import |
| TS6192 | 5 | whole import declaration unused |
| TS2304 | 3 | **live bug** — missing import |
| TS2741 | 1 | **live bug** — missing object property |

58 of the 62 are extraction cruft and delete cleanly. The remaining 4 are two real defects.

## Approach

Derive the host type from the class rather than hand-writing an interface:

```ts
import type { InteractiveMode } from "./interactive-mode.js";
export type InteractiveModeDelegateHost = InteractiveMode;
```

The import is type-only, so it is erased at emit and the delegate to host to mode cycle has no
runtime edge. The 13 existing import sites are unchanged.

A hand-written interface was rejected. It would be a 159-line mirror of the class requiring manual
maintenance, and the codebase already demonstrates how that ages: `interactive-mode-state.ts`
declares a second, parallel `InteractiveModeStateHost` for the `controllers/` directory whose own
comment concedes it "uses `any` for TUI/session surfaces — same convention as
InteractiveModeDelegateHost". One hand-maintained mirror has already drifted into `any`. A derived
type cannot drift, because the contract is the class.

Deleting the 66 delegate wrappers and having delegates call sibling modules directly was also
rejected for this change. It is a large behavioural diff across 13 files, it breaks the test fake
hosts that stub `host.foo()`, and direct sibling calls are precisely what produced the
`resetExtensionUI` defect below. It is a reasonable follow-up once the seam is type-checked.

### Validation of the approach

With the alias in place and every `@ts-nocheck` removed, tsc reported **zero** `TS2341`
("property is private") and **zero** "property does not exist" errors. The class type covers the
entire 159-member delegate surface exactly.

## Changes

### Visibility

Remove `private` from the 138 members the delegates touch — the 102 that `noUnusedLocals` reports
plus 36 more that are read both inside the class and from delegates. This includes the three
`private get` accessors (`agent`, `sessionManager`, `settingsManager`) and the `private options`
constructor parameter property. Members no delegate touches stay private.

The rule is self-verifying: missing one raises `TS2341` as soon as `@ts-nocheck` is removed.

`private` on a member written and read through an `any` host is a claim the compiler was never able
to check. Removing it records what the code already does.

### Bug 1 — `ReferenceError` on `/reload`

`interactive-extension-widgets.ts:212` `resetExtensionUI()` calls `hideExtensionSelector(host)`,
`hideExtensionInput(host)` and `hideExtensionEditor(host)`. None are imported into that file; all
three are defined in `interactive-extension-dialogs.ts`. `interactive-extension-system.ts`
re-exports both modules, but ESM scope is per-file, so the bare identifiers are undefined at
runtime.

Reachable path: `/reload` with an extension dialog open leads to `handleReloadCommand`
(`interactive-command-handlers.ts:28`) which calls `host.resetExtensionUI()`. The calls are guarded
by `if (host.extensionSelector)` and friends, so the crash needs a dialog to be open.

Fix: import the three functions from `./interactive-extension-dialogs.js`.

### Bug 2 — `getAllTools` missing from the interactive command context

`interactive-extension-widgets.ts:27` builds `commandContextActions` as an inline object literal
and omits `getAllTools`. An extension command that calls it receives `undefined`.

`modes/shared/command-context-actions.ts` exports `createDefaultCommandContextActions`, which
supplies `getAllTools` along with six other actions. Print mode and RPC mode both use it. Its
docstring names interactive mode as the intended caller: "Callers can spread the result and
override individual actions to add mode-specific behavior (e.g., interactive mode clears TUI state
after forking)."

Fix: spread `createDefaultCommandContextActions(host.session)` and retain only the genuine TUI
overrides.

### Dead weight

- `interactive-selectors-settings.ts` contains its entire 28-line import block twice, verbatim
  apart from tab-versus-space indentation on four lines. Delete the space-indented copy; this
  alone clears 58 errors.
- 58 unused imports and type imports across 6 files.

### Flag

Enable `noUnusedLocals` in `packages/gsd-agent-modes/tsconfig.json` and remove the `"//"` key that
documents why it was off.

## Testing

The two behavioural bugs get tests first, written to fail against current code:

1. `resetExtensionUI` with an open extension selector completes without throwing. Fails today with
   `ReferenceError: hideExtensionSelector is not defined`.
2. The command-context actions built by interactive mode expose `getAllTools`, and calling it
   reaches the session. Fails today because the property is absent.

For the type-level work the compiler is the test: `tsc --noEmit` clean with `noUnusedLocals` and no
`@ts-nocheck`.

A guard test asserts no `@ts-nocheck` remains under `modes/interactive/`, so the escape hatch
cannot quietly return.

### Verification

- `pnpm --filter @gsd/agent-modes run build`
- The 11 interactive test files: 56 tests, green baseline established before any change
- `pnpm run test:packages`, which carries 6 known pre-existing failures (5 mcp-server artifact
  assertions, 1 pi-tui spinner) unrelated to this work

Note that `run-package-tests.cjs` discovers compiled tests recursively under
`dist-test/packages/<pkg>/src`, so all 42 of the package's test files do run in CI. The package's
own `pnpm test` script globs `src/**/*.test.ts`, which the shell expands one level deep and which
therefore runs only 3 of the 42. That is a separate defect and is out of scope here.

## Sequencing

1. Regression tests for both bugs, confirmed red
2. Fix bug 1 and bug 2, confirmed green
3. Delete the duplicated import block
4. Derive the host type and remove `private` from the 138 members
5. Remove `@ts-nocheck` from all 13 files
6. Delete the unused imports
7. Enable `noUnusedLocals`
8. Full verification

## Out of scope

- `InteractiveModeStateHost` in `interactive-mode-state.ts` and the 8 `controllers/` files that use
  it keep their current `any`-typed structural interface. Once the fields are public the class
  should structurally satisfy it, which would let the `this as any` casts at
  `interactive-mode.ts:372` and `:384` drop. Take that if it falls out for free; do not pursue it.
- Deleting the 66 delegate wrapper methods.
- The shallow `pnpm test` glob in the package manifest.
