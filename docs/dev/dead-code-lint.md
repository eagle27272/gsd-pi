# Dead-code lint (knip)

`noUnusedLocals` / `noUnusedParameters` (see `tsconfig.options.json`) catch unused
locals, parameters, imports and non-exported types. They cannot see an **exported**
symbol that nothing imports, which in a repo this size is the more common form of
drift. [knip](https://knip.dev) closes that gap, plus unused files, unused
dependencies, and unused class and enum members.

## Running it

```bash
pnpm run lint:dead-code
```

Takes about 20 seconds. It runs in CI (`.github/workflows/ci.yml`), in
`scripts/ci-fast-gates.sh` (`pnpm run verify:fast`) and in `scripts/verify-merge.sh`.

## The baseline ratchet

A fully clean run would mean deleting or de-exporting ~1,800 symbols. Rather than
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

Regenerating accepts whatever the tree currently reports, including dead code added by
the same change — so a regeneration in a PR that also touches source needs a look at the
diff of the baseline itself, not just at the fact that the gate went green.

When a baselined finding stops occurring the gate says so and still passes, so you can
tighten the baseline in the same PR that removes the dead code.

## What the config does

`knip.jsonc` carries inline comments for each decision. The three that are not obvious:

- **Vendored `packages/pi-*`** list all their source as `entry`. Their dependency usage
  stays visible to the root workspace — so root deps like `openai` are not falsely
  reported as unused — while they produce no findings of their own, and an upstream sync
  never moves the baseline.
- **`includeEntryExports` is set on the root workspace only.** Every extension is
  reached through its `index.ts` entry, and without this the entire extension surface
  would be exempt from unused-export analysis. It is deliberately *not* global, because
  the pi-\* workspaces above treat all their source as entry.
- **`include` restates the default issue types** because knip treats it as a whitelist,
  and `classMembers` has to be listed explicitly to be enabled at all.

## What knip does *not* catch

**Never-read interface or type-literal properties.** knip's member analysis covers
classes and enums only. This matters because both cases that motivated the gate are
interface properties:

- `RefMetadata.frameContext` (`src/resources/extensions/browser-tools/state.ts`) — see #79.
- `FuzzyMatchResult.contentForReplacement`, fixed in c680e785 after it shipped a real bug.

Nothing in the TypeScript tooling ecosystem reports these; detecting them needs a custom
TS-compiler-API pass. Tracked separately.

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
- **Two imports of a deleted module.** `scripts/m003-s07-dossier-input.ts` and its test
  import `./semantic-shadow-no-cutover-gate.mjs`, removed in 185af73a. The `.ts` test is
  not in any runner's glob, so nothing caught it.
