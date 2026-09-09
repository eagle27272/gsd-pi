# Pre-removal Baseline: strip-to-cli

Captured on 2026-09-08 for the strip-to-cli removal effort (Task 1).

## Build Baseline: `pnpm run build:core`

**Exit code:** 0

**Build output (tail):**
```
> @opengsd/gsd-pi@1.18.0 build:mcp-server /Users/mirogers/git/eagle27272/gsd-pi
> pnpm --filter @opengsd/mcp-server run build

> @opengsd/mcp-server@1.18.0 build /Users/mirogers/git/eagle27272/gsd-pi/packages/mcp-server
> node ../../scripts/clean-package-dist.cjs && tsc --incremental false

> @opengsd/gsd-pi@1.18.0 build:daemon /Users/mirogers/git/eagle27272/gsd-pi
> pnpm --filter @opengsd/daemon run build

> @opengsd/daemon@1.18.0 build /Users/mirogers/git/eagle27272/gsd-pi/packages/daemon
> node ../../scripts/clean-package-dist.cjs && tsc

> @opengsd/gsd-pi@1.18.0 copy-resources /Users/mirogers/git/eagle27272/gsd-pi
> node scripts/copy-resources.cjs

> @opengsd/gsd-pi@1.18.0 copy-themes /Users/mirogers/git/eagle27272/gsd-pi
> node scripts/copy-themes.cjs

> @opengsd/gsd-pi@1.18.0 copy-export-html /Users/mirogers/git/eagle27272/gsd-pi
> node scripts/copy-export-html.cjs
```

Build completed successfully with no errors or warnings.

## Unit Test Baseline: `pnpm run test:unit`

**Exit code:** 1 (tests ran with failures)

**Test Results Summary:**
- **Passed:** 14893
- **Failed:** 23
- **Skipped:** 28

**Known Failing Tests** (baseline failures to ignore in regression gate):

1. native exact removal rechecks content at its final mutation boundary
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

2. native exact tree publication proves staging before live exposure
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

3. tree evidence deletion resumes from its durable deleting phase
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

4. tree deletion promotes a durable prepared consent manifest after restart
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

5. tree deletion retains an unbound manifest temporary and fails closed
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

6. tree deletion excludes children arriving after reviewed consent
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

7. a torn deletion manifest never extends reviewed tree consent
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

8. native deletion acknowledgement waits for complete ledger validation
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

9. native deletion acknowledgement preflights every retained digest
   - Error: `handle.setMutationBoundaryFaultForTest is not a function`

10. native deletion acknowledgement resumes after manifest removal
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

11. tree retirement preserves a final unmanifested racer
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

12. tree retirement does not unlink individual child bytes
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

13. tree retirement keeps reviewed child identity in its tombstone
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

14. tree retirement leaves no child-level deletion claim
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

15. tree deletion returns a snapshot racer to the public evidence ledger
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

16. tree publication crash before rename never exposes staging
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

17. tree publication resumes a durably identified partial snapshot
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

18. tree publication rechecks its private claim at the final rename boundary
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

19. tree publication preserves a source replacement outside its private claim
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

20. tree publication source replacement remains public recovery evidence
    - Error: `native projection root identity locking failed`

21. tree publication rejects a replacement after its final snapshot proof
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

22. tree publication rejects content changed in its private snapshot
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

23. tree publication replay retains a bound completion claim
    - Error: `handle.setMutationBoundaryFaultForTest is not a function`

All failing tests are located in: `dist-test/src/resources/extensions/gsd/tests/migrate-safety-audit.test.js`

## Smoke Test: `node scripts/dev-cli.js --help`

**Exit code:** 0

**Output:** Successfully printed CLI help with full usage documentation.

**Warnings:** None

## Summary

- Build: Success (exit 0)
- Unit tests: 14893 passed, 23 failed (known failures), 28 skipped
- Smoke test: Success (exit 0)
- All systems ready for strip-to-cli removal tasks
