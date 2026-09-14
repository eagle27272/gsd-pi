#!/usr/bin/env node
/**
 * vendor-pi.cjs — one-shot sync of the vendored @gsd/pi-* packages from earendil-works/pi.
 *
 * Usage:
 *   node scripts/vendor-pi.cjs [--ref v0.75.5] [--checkout-only] [--skip-checkout] [--dry-run]
 *
 * Prerequisites:
 *   - git available on PATH
 *   - ADR-010 clean seam complete (GSD code in gsd-agent-core / gsd-agent-modes)
 *
 * This is the only vendoring script that talks to the upstream remote, so it is
 * the only one that takes --ref. It refreshes .cache/pi-upstream at that ref
 * (default: pinnedRef in pi-upstream.json), then runs the post-vendor pipeline
 * below. The pipeline scripts read whatever .cache/pi-upstream already holds and
 * accept no arguments; use --checkout-only to stage a ref before running them by
 * hand (docs/dev/pi-upstream.md, "Upgrade workflow" step 2).
 *
 * pi-coding-agent is deliberately not copied wholesale: vendor-pi-coding-agent-core.cjs
 * syncs only src/core and src/utils and restores the seam files around them.
 */
'use strict'

const { existsSync, mkdirSync, readFileSync } = require('fs')
const { join, resolve, dirname } = require('path')
const { execFileSync } = require('child_process')

const REPO_ROOT = resolve(__dirname, '..')
const UPSTREAM_CONFIG_PATH = join(__dirname, 'pi-upstream.json')
const CACHE_DIR = join(REPO_ROOT, '.cache', 'pi-upstream')

const PIPELINE = [
  ['vendor-pi-deps.cjs', 'pi-agent-core, pi-ai, pi-tui + import/package.json/tsconfig normalization'],
  ['vendor-pi-coding-agent-core.cjs', 'pi-coding-agent src/core + src/utils, seam files preserved'],
  ['apply-seam.cjs', 'post-vendor deletes, import rewrites, index trim, boundary verify'],
]

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`)
  process.exit(1)
}

function loadConfig() {
  return JSON.parse(readFileSync(UPSTREAM_CONFIG_PATH, 'utf8'))
}

function parseArgs(argv) {
  const opts = { dryRun: false, ref: null, checkoutOnly: false, skipCheckout: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--checkout-only') opts.checkoutOnly = true
    else if (arg === '--skip-checkout') opts.skipCheckout = true
    else if (arg === '--ref') {
      if (!argv[i + 1]) fail('--ref requires a value, e.g. --ref v0.75.5')
      opts.ref = argv[++i]
    } else fail(`Unknown argument: ${arg}`)
  }
  if (opts.checkoutOnly && opts.skipCheckout) {
    fail('--checkout-only and --skip-checkout are mutually exclusive')
  }
  return opts
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function ensureUpstreamCheckout(repoUrl, ref) {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(dirname(CACHE_DIR), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', ref, '--', repoUrl, CACHE_DIR], REPO_ROOT)
    return
  }

  // Fetch the requested ref by name: a shallow clone pinned to another tag has
  // no refspec that would bring it in, so a bare `git fetch` leaves the cache
  // on the old ref and `git checkout <ref>` fails.
  run('git', ['fetch', '--depth', '1', 'origin', ref], CACHE_DIR)
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], CACHE_DIR)
}

function runPipeline(dryRun) {
  for (const [script, purpose] of PIPELINE) {
    process.stderr.write(`${dryRun ? '[dry-run] ' : ''}node scripts/${script}  # ${purpose}\n`)
    if (!dryRun) run(process.execPath, [join(__dirname, script)], REPO_ROOT)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const ref = opts.ref || config.pinnedRef

  if (opts.skipCheckout) {
    if (!existsSync(CACHE_DIR)) {
      fail('--skip-checkout needs a populated .cache/pi-upstream; run with --ref first')
    }
  } else {
    if (!ref) fail('No upstream ref. Set pinnedRef in scripts/pi-upstream.json or pass --ref')
    process.stderr.write(`${opts.dryRun ? '[dry-run] ' : ''}Vendoring earendil-works/pi @ ${ref}\n`)
    if (!opts.dryRun) ensureUpstreamCheckout(config.repository, ref)
  }

  if (opts.checkoutOnly) {
    process.stderr.write('checkout-only: .cache/pi-upstream staged, pipeline skipped.\n')
    return
  }

  runPipeline(opts.dryRun)

  process.stderr.write(
    'Done. Next: reconcile the patchAllowlist shims and verify — docs/dev/pi-upstream.md, "Upgrade workflow" steps 3 onward.\n',
  )
}

main()
