# Never-read interface properties: a TypeScript-compiler-API dead-code gate

Design for [#185](https://github.com/eagle27272/gsd-pi/issues/185). Companion to the
knip gate from [#81](https://github.com/eagle27272/gsd-pi/issues/81), which landed in
09f990f5.

## The gap

`noUnusedLocals` / `noUnusedParameters` catch unused locals, parameters, imports and
non-exported types. knip catches exported symbols with no importers, unused files,
unused dependencies, and unused **class and enum** members.

Neither catches a never-read **interface** property. knip has no interface-member
rule, and neither does `tsc`, `ts-prune`, `biome`, or `@typescript-eslint`. That
shape — a property written at one site and read nowhere — is the one that has
actually cost this repo:

- `RefMetadata.frameContext` (#79), fixed in ba897845.
- `FuzzyMatchResult.contentForReplacement`, removed in c680e785 (#38) after it
  shipped a real bug.
- `RefMetadata.selectorScope` ([#205](https://github.com/eagle27272/gsd-pi/issues/205)),
  found by the prototype for this gate and still live at the time of writing.

## What the prototype established

A throwaway probe over the whole repo, since discarded:

| | measurement |
|---|---|
| Program build + full AST walk | 9s, 2,871 files (knip takes 60–90s) |
| First-party `PropertySignature` declarations | 21,906 |
| Symbol-identity join → write-only findings | 1,823 outside tests |
| Name-keyed-read join → write-only findings | 186 outside tests, 6 in tests |
| Precision spot-check of the name-keyed set | 3/3 true positives |

Two results reshape the approach the issue sketched.

**The issue's proposed method does not work.** "Use the language service to find
references" is symbol-based, so it inherits the structural-typing blind spot
described below *and* costs one `findReferences` call per property — 21,906 of them.
A single whole-program AST walk is both faster and no less accurate.

**Structural typing is the adversary, not read/write classification.** Classifying a
reference as a read or a write is straightforward once object-literal keys are
bridged through `getContextualType`. What is hard is that a read through a
structurally-compatible but nominally separate interface never links by symbol.
`WorktreeStatus.name` (`src/worktree-cli-status.ts:29`) is read in practice, but only
via `WorktreeStatusLike` (`src/worktree-cli-format.ts:3`); a symbol-identity join
reports it as dead. That single effect is what inflates 186 findings to 1,823, and it
is a property of the type system rather than a bug that can be fixed.

## Approach

Index **reads by property name** and **writes by declared symbol**. A property is
reported when it is written at least once and no property of that name is read
anywhere in the program.

This trades recall for precision. A same-named property on an unrelated type that
*is* read will mask a genuine finding — `UnitMetrics.cacheHitRate`
(`src/resources/extensions/gsd/metrics.ts:67`, written at `:240` and `:438`, read
nowhere) is masked by `CompletionDashboardSnapshot.cacheHitRate`. That is an accepted
cost. For something wired into three CI runners, the correct failure mode is silence
rather than noise.

Two alternatives were considered and rejected:

- **Symbol identity widened by assignability.** For each candidate, test
  assignability against every type declaring that property. Recovers `cacheHitRate`
  and its class. Rejected: TS assignability checks are expensive and the pass is
  O(candidates × types), turning seconds into minutes, for materially more code.
- **The issue's original `findReferences` sketch.** Slowest of the three, and it does
  not solve the structural problem it would need to solve to justify the cost.

## Components

Mirrors the knip gate file-for-file, so there is one pattern to learn.

| file | role |
| --- | --- |
| `scripts/lib/iface-props-lib.mjs` | Pure functions: collect declarations, classify references, flatten to keys, diff, render, parse |
| `scripts/iface-props-gate.mjs` | CLI: build the program, run the lib, diff against the baseline, `--write` to regenerate |
| `.config/iface-props-baseline.json` | The ratchet |
| `scripts/__tests__/iface-props-gate.test.mjs` | Unit tests and wiring-drift tests |

The split is the same one `scripts/knip-gate.mjs` and
`scripts/lib/knip-baseline-lib.mjs` use, and for the same reason: everything
testable without spawning a compiler lives in the lib.

Wiring:

- `package.json`: `lint:dead-code:props` and `lint:dead-code:props:update`
- `.github/workflows/ci.yml`, `scripts/ci-fast-gates.sh`, `scripts/verify-merge.sh` —
  the same three runners as `lint:dead-code`
- `docs/dev/dead-code-lint.md` — its "What knip does *not* catch" section currently
  says this case is untracked and needs rewriting

## Program construction

An explicit glob list, not a tsconfig. `tsconfig.json` excludes
`src/resources/extensions`, which is the largest body of first-party code in the
repo, so no single existing tsconfig sees the surface this gate needs.

Declaration globs mirror knip.jsonc's first-party scope:

```
src/**/*.ts
scripts/**/*.ts
packages/contracts/src/**/*.ts
packages/db/**/*.ts
packages/gsd-agent-core/src/**/*.ts
packages/gsd-agent-modes/src/**/*.ts
packages/mcp-server/src/**/*.ts
packages/native/src/**/*.ts
packages/rpc-client/src/**/*.ts
```

`packages/db` is matched without a `src/` segment because it has no `package.json`
and is not a pnpm workspace; knip.jsonc reaches it the same way. Test files are in
scope — a write-only property in a test is usually a stale assertion, and six of the
~192 baseline findings are in `.test.ts` files.

`packages/pi-*` is included in the **program** so that reads from vendored code
count, but excluded from **declaration collection**. This matches both the issue's
scope and knip's, and carries the same known cost the knip docs record:
`contentForReplacement` lived in `packages/pi-coding-agent`, so even with this gate
in place that specific finding would not have been caught where it actually was.

The analysed set must be a function of this config alone — the same determinism
argument behind knip's `--no-gitignore` flag. `.d.ts` files are excluded from
declaration collection.

## Classification

Declarations: every `PropertySignature` with an identifier or string-literal name, in
a first-party non-`.d.ts` file. This covers both `interface` members and type-literal
members, including type literals nested in aliases and function signatures.

References, resolved in one walk over every source file in the program:

| form | classification | resolution |
| --- | --- | --- |
| `obj.prop` | read | `getSymbolAtLocation` on the name |
| `obj.prop = v` | write | as above, when LHS of a plain `=` |
| `obj.prop += v`, `obj.prop++` | read | compound assignment reads before it writes |
| `obj["prop"]` | read | `getPropertyOfType` on the object's type |
| `{ prop: v }`, `{ prop }` | write | `getPropertyOfType` on the literal's **contextual type** |
| `const { prop } = obj` | read | `getPropertyOfType` on the binding pattern's type |
| `{ ...obj }` | read, all properties | `getPropertiesOfType` on the spread type |

The contextual-type bridge is load-bearing. `getSymbolAtLocation` on an
object-literal key returns the *literal's own* property symbol, not the interface
property it satisfies, and `getRootSymbols` does not bridge the two. Without the
bridge the classification is simply wrong: a prototype lacking it reported a
reconstructed `frameContext` as untouched rather than write-only, and reported a
destructured-and-used property as untouched as well.

Spreads count every property of the spread type as read. This is deliberately
conservative — a spread propagates properties invisibly, and under-reporting there is
much cheaper than a false positive.

Union and intersection contextual types are walked constituent-by-constituent, so a
key satisfying `A | B` links to the declaration in both.

## Finding keys and the baseline

Keys are `writeOnly|<file>|<Owner>.<property>`, with no line or column. This follows
knip's reasoning: moving code within a file should not read as a new finding.
`writeOnly` is the only finding type today; it occupies the same leading field as
knip's issue type so the two baselines stay legible side by side.

**Anonymous type literals need a real owner label.** Naming them all
`<type-literal>` breaks the key's uniqueness — `scanners.ts` alone produced eight
distinct `<type-literal>.items` entries in the prototype, which would collapse to a
single key, so deleting seven of the eight would go undetected. The owner is
therefore the nearest *named* enclosing declaration — interface, type alias,
function, method, or variable — which is stable under movement within a file and
unique in practice.

Concretely, a property signature inside a type literal in the return type of
`function scanClaude()` keys as `writeOnly|…/scanners.ts|scanClaude.items`, and a
property on `interface RefMetadata` keys as
`writeOnly|…/state.ts|RefMetadata.selectorScope`. When two type literals share the
same nearest named ancestor and the same property name, the key collides; the
implementation must detect that case and fall back to appending a
declaration-order index rather than emitting a duplicate key silently.

The baseline file format, the `--write` regeneration flow, the sorted-and-round-
trippable on-disk representation, and the "resolved findings still pass but are
reported" behaviour all match `scripts/lib/knip-baseline-lib.mjs` exactly.

## Escape hatch

The baseline is the only suppression mechanism. There is no per-property marker.

Genuinely write-only fields do exist — serialisation payloads, external wire
contracts, structural conformance to a third-party shape — and they go into
`.config/iface-props-baseline.json` through `--write`, with the justification in the
PR. One mechanism and one place to audit, consistent with what #81 just established.
A JSDoc marker was considered and rejected: it adds a second suppression path, and
markers rot silently once the field stops being written at all.

## Testing

TDD, following the structure of `scripts/__tests__/knip-gate.test.mjs`.

**Classification** — in-memory `ts.createProgram` fixtures, one per reference form in
the table above, asserting read/write/untouched for each.

**The #79 regression** — a fixture reconstructing `RefMetadata` with a write-only
`frameContext`, asserting it is reported. This is the regression the issue exists for
and the single most important test in the suite. The prototype has already been
validated against this fixture.

**False-positive categories** — one fixture each, asserting *no* finding:

- a discriminant property (`kind: "a"`) narrowed but never read as a property
- a property reached only through a spread
- a property read only by destructuring
- a property read only by string-literal element access
- a property read only through a structurally-compatible separate interface

**Baseline mechanics** — flatten/diff/parse/render unit tests, and a round-trip test
asserting `renderBaselineFile(parseBaseline(text)) === text` against the committed
file so regeneration produces no spurious diff.

**Wiring drift** — assert the gate appears in `ci.yml`, `ci-fast-gates.sh` and
`verify-merge.sh`. Note the limitation the knip docs already record: nothing in
`.github/workflows/` runs `scripts/__tests__/`, so these drift tests are local-only
today (tracked in #191).

**Glob rot** — assert every declaration glob matches at least one file, mirroring the
equivalent knip.jsonc test. A glob that matches nothing silently exempts the code it
was meant to cover.

## Rollout

Land the gate with the ~192 existing findings baselined as-is rather than burning
them down in the same change. This is #81's reasoning and it applies unchanged: the
triage is its own work, and bundling it would make the gate's own diff unreviewable.

`docs/dev/dead-code-lint.md` gains:

- a rewrite of the "What knip does *not* catch" section, which currently says this
  case is untracked
- a "known contents worth burning down" list for the new baseline, matching the
  section that already exists for knip's
- an honest statement of the name-keying false negative, naming `cacheHitRate` as the
  worked example

## Out of scope

- Re-litigating the knip tool choice. knip stays; this runs alongside it.
- Burning down the baseline.
- Extending coverage to `packages/pi-*`. That exemption is owned by the pi boundary
  (`scripts/verify-pi-boundary.cjs`) and deleting code there fights upstream syncs.
- Fixing `RefMetadata.selectorScope`. Filed separately as
  [#205](https://github.com/eagle27272/gsd-pi/issues/205).
