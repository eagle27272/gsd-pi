# Dead-code lint

`noUnusedLocals` / `noUnusedParameters` (see `tsconfig.options.json`) catch unused
locals, parameters, imports and non-exported types. They cannot see an **exported**
symbol that nothing imports, which in a repo this size is the more common form of
drift. Two gates close that gap: [knip](https://knip.dev) covers unused files,
exports, dependencies, and class and enum members; a custom interface-property gate
covers properties that are written somewhere and read nowhere, which knip's member
analysis does not reach.

## Running it

```bash
pnpm run lint:dead-code
```

Takes about a minute. It runs in CI (`.github/workflows/ci.yml`), in
`scripts/ci-fast-gates.sh` (`pnpm run verify:fast`) and in `scripts/verify-merge.sh`.

### Interface properties

```bash
pnpm run lint:dead-code:props
```

Takes about ten seconds. Runs in the same three places as the knip gate.

This is a custom pass over the TypeScript compiler API
(`scripts/lib/iface-props-lib.mjs`) rather than a third-party tool, because no
tool reports this: knip's member analysis covers classes and enums only, and
`tsc`, `ts-prune`, `biome` and `@typescript-eslint` have no interface-member rule
at all.

Declarations are collected from `.ts` files only, but the program that resolves
reads against them also includes `.mjs`/`.cjs`/`.js` files (with `allowJs: true`):
`packages/native`'s test suite is entirely `.mjs`, and without those extensions in
the program every read from it would be invisible, making its properties look
write-only. knip needed the same widening for the same reason — see the `project`
glob comment for the root workspace in `knip.jsonc`.

### What the interface-property gate trades away

Reads are matched by property **name**, not by symbol. TypeScript is structurally
typed, so a read through a compatible-but-separate interface never links back to
the declaration: `WorktreeStatus.name` (`src/worktree-cli-status.ts`) is read only
via `WorktreeStatusLike` (`src/worktree-cli-format.ts`), and a symbol-identity join
calls it dead. A throwaway prototype of a symbol-identity join (see the design
spec's "What the prototype established" table) turned roughly 190 name-keyed
findings into roughly 1,800, almost all of them reads the join could not see. That
prototype predates this pass's `allowJs` program widening and has not been re-run
against it, so read the ratio as directional, not as a current measurement.

The cost is recall. A same-named property on an unrelated type that *is* read masks
a genuine finding: `CompletionDashboardSnapshot.cacheHitRate`
(`src/resources/extensions/gsd/auto-dashboard.ts`) is written and read nowhere. But
`UnitMetrics.cacheHitRate` (`src/resources/extensions/gsd/metrics.ts`) — a different,
unrelated interface that happens to share the name — is written twice and then
spread into six test fixtures as `Partial<UnitMetrics>` (e.g.
`src/resources/extensions/gsd/tests/metrics.test.ts`), which the gate counts as
reading every `UnitMetrics` property. Reads are matched by name, so that spread
keeps the gate quiet about both properties. That is the intended bias — for
something wired into three CI runners, silence is a cheaper failure than noise.

The gate also reports only properties that are **written somewhere**. A property
declared and never touched at all is not reported here; knip's `types` and `exports`
rules approach that case from the other side.

## The baseline ratchet

A fully clean run would mean deleting or de-exporting ~1,500 symbols. Rather than
bundle that into the rollout, `.config/knip-baseline.json` records every finding that
existed when the gate landed, and `scripts/knip-gate.mjs` fails only on findings that
are **not** in that list.

Each finding is keyed `type|file|symbol` with no line number, so moving code within a
file does not register as new.

When the gate fails, the fix is to delete the dead code. Only regenerate the baseline
when a finding legitimately moved — a file rename, a symbol rename, an upstream sync:

```bash
pnpm run lint:dead-code:update
```

Never hand-edit `.config/knip-baseline.json`. Explain any regeneration in the PR.

Both gates share this mechanism through `scripts/lib/baseline-ratchet.mjs`. The
interface-property gate's baseline is `.config/iface-props-baseline.json`,
regenerated with `pnpm run lint:dead-code:props:update`; everything above about
when to regenerate and never hand-editing applies there too.

Regenerating accepts whatever the tree currently reports, including dead code added by
the same change — so a regeneration in a PR that also touches source needs a look at the
diff of the baseline itself, not just at the fact that the gate went green.

When a baselined finding stops occurring the gate says so and still passes, so you can
tighten the baseline in the same PR that removes the dead code.

## What the config does

`knip.jsonc` carries inline comments for each decision. The three that are not obvious:

- **Vendored `packages/pi-*`** list all their source as `entry`, and set
  `ignoreDependencies: [".*"]`. Their dependency usage stays visible to the root
  workspace — so root deps like `openai` are not falsely reported as unused — while they
  produce no findings of their own. Entry/project globs govern file and export analysis
  but not manifest analysis, so the `ignoreDependencies` line is what actually makes
  "an upstream sync never moves the baseline" true.
- **`includeEntryExports` is set on the root workspace only.** Every extension is
  reached through its `index.ts` entry, and without this the entire extension surface
  would be exempt from unused-export analysis. It is deliberately *not* global, because
  the pi-\* workspaces above treat all their source as entry.
- **`include` restates the default issue types** because knip treats it as a whitelist,
  and `classMembers` has to be listed explicitly to be enabled at all.

`scripts/knip-gate.mjs` also passes `--no-gitignore`, which is load-bearing rather than a
convenience. knip's gitignore matcher applies this repo's `src/**/*.js`-style patterns
more broadly than git does and silently drops real files from analysis: with it on, 311
symbols that are demonstrably used — `AgentSession.abortBash`, called at
`packages/gsd-agent-modes/src/modes/interactive/interactive-key-handlers.ts:30`, among
them — are reported as dead. Turning it off makes the analysed set a function of
`knip.jsonc` alone, so the baseline is identical on every machine and in CI instead of
varying with local ignore state. `ignoreUnresolved` covers `dist/` paths for the same
reason: the gate runs before `build:core`, so those imports would otherwise resolve or not
depending on build state.

## What knip does *not* catch

**Never-read interface or type-literal properties.** knip's member analysis covers
classes and enums only. A second gate covers this case — see "Interface properties"
above — because both findings that motivated knip were interface properties:

- `RefMetadata.frameContext` (`src/resources/extensions/browser-tools/state.ts`),
  #79, fixed in ba897845 (#129).
- `FuzzyMatchResult.contentForReplacement`, fixed in c680e785 (#38) after it shipped
  a real bug.

Note that `contentForReplacement` lived in
`packages/pi-coding-agent/src/core/tools/edit-diff.ts`. The vendored tree is out of
scope for both gates, so neither would have caught it where it actually was.

**Anything inside the vendored `packages/pi-*` tree.** That exemption is deliberate — the
pi boundary (`scripts/verify-pi-boundary.cjs`) owns those packages, and deleting code
there fights upstream syncs — but it costs real coverage: about 670 of the repo's ~3,400
first-party source files.

**Its own drift tests, in CI.** `scripts/__tests__/knip-gate.test.mjs` asserts the gate is
wired into all three runners and that no config glob has rotted, but nothing in
`.github/workflows/` runs `scripts/__tests__/` or `ci-fast-gates.sh` — those tests are
local-only today. Pre-existing and repo-wide, tracked in #191.

## Known baseline contents worth burning down

- **21 unused root `dependencies`.** Each is declared by the vendored package that
  actually uses it, so the root copy may be redundant — but the published tarball bundles
  from the root, so removing them needs a packaging check first.
- **`tsx` and `vitest` as unlisted binaries.** `test:live-workflow:unit` and
  `test:pi-claude-schemas` invoke them without either being a root devDependency; they
  resolve only through pnpm hoisting.
- **`packages/db`** imports `drizzle-orm` and `@neondatabase/serverless`, neither of which
  is a dependency anywhere in the repo. The package has no `package.json`, so pnpm does not
  treat it as a workspace; knip sees it only because the root `project` glob names it.
- **`packages/db/src/schema/` imports `./auth.js` and `./devices.js`**, neither of which
  exists. Consistent with the package being unreachable aspirational code.

### Interface-property baseline contents worth burning down

- **177 accepted findings at rollout.** Each is a property written at one or more
  sites and matched by the gate's name-keyed join at none. That is not the same as
  "read nowhere in the program": a read can still be invisible to the join, through
  an untyped `.js` consumer, a `Record<string, unknown>` or other index-signature
  access, or a narrowed union member the checker resolves to no symbol. Confirm
  there is no such consumer before deleting a baselined property; if there is,
  the finding is a missing read, not dead code.
- **Three are options forwarded whole into a third-party API and must not be
  deleted**, even though nothing in this repo's TypeScript reads them back:
  `opts.dot` (`src/resources/extensions/gsd/safety/file-change-validator.ts:26`)
  is passed to `picomatch` at `:124` so that `**/.hidden` patterns match (see the
  comment at `:123`) — deleting it would silently change what the safety
  validator matches. `opts.stdio`, in both `src/claude-cli-check.ts:30` and
  `src/resources/extensions/claude-code-cli/readiness.ts:39`, is forwarded
  wholesale into `execFileSync`.
- **Six are in `.test.ts` files.** A write-only property in a test usually means an
  assertion was weakened or removed and the fixture field outlived it.
- **`RefMetadata.selectorScope`** (`src/resources/extensions/browser-tools/state.ts`)
  is the same shape as #79 on the same interface: written at
  `src/resources/extensions/browser-tools/tools/refs.ts`, read nowhere, and
  `validateRefForAction` never consults the snapshot's selector scope. Tracked as
  #205.
