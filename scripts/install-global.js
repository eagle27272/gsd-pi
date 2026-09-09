#!/usr/bin/env node

/**
 * Link (or unlink) the `gsd` CLI from this source checkout into a global bin
 * directory, so `gsd` runs in any project without publishing to a registry.
 *
 * The symlinks point at `dist/bootstrap.js` in this repo, so a later
 * `git pull && pnpm run build:core` updates the global `gsd` in place — no
 * re-link needed.
 *
 *   node scripts/install-global.js              Link gsd + gsd-cli
 *   node scripts/install-global.js --uninstall  Remove the links this repo owns
 *   node scripts/install-global.js --bin-dir D  Use D instead of `npm prefix -g`
 *
 * Env override: GSD_GLOBAL_BIN_DIR takes the place of --bin-dir.
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(__dirname, '..')
const isWindows = process.platform === 'win32'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    `Link the gsd CLI from this checkout into a global bin directory.\n\n` +
    `  node scripts/install-global.js              Link gsd + gsd-cli\n` +
    `  node scripts/install-global.js --uninstall  Remove the links this repo owns\n` +
    `  node scripts/install-global.js --bin-dir D  Use D instead of \`npm prefix -g\`\n\n` +
    `Env: GSD_GLOBAL_BIN_DIR overrides the target bin directory.\n`,
  )
  process.exit(0)
}

const uninstall = args.includes('--uninstall')
const binDirFlagIndex = args.indexOf('--bin-dir')
const binDirOverride =
  binDirFlagIndex !== -1 ? args[binDirFlagIndex + 1] : process.env.GSD_GLOBAL_BIN_DIR

function fail(message) {
  process.stderr.write(`install-global: ${message}\n`)
  process.exit(1)
}

/** Bin names from package.json whose target lives in dist/ (i.e. the built CLI). */
function resolveCliBins() {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const bin = pkg.bin || {}
  return Object.entries(bin)
    .filter(([, rel]) => rel.replace(/\\/g, '/').startsWith('dist/'))
    .map(([name, rel]) => ({ name, target: join(packageRoot, rel) }))
}

function resolveBinDir() {
  if (binDirOverride) return resolve(binDirOverride)
  try {
    const prefix = execFileSync(isWindows ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // POSIX npm puts bins in <prefix>/bin; on Windows they sit in <prefix>.
    return isWindows ? prefix : join(prefix, 'bin')
  } catch {
    fail('could not resolve `npm prefix -g` — pass --bin-dir <path> or set GSD_GLOBAL_BIN_DIR')
  }
}

function ownedByThisRepo(linkPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false
    return resolve(dirname(linkPath), readlinkSync(linkPath)).startsWith(packageRoot)
  } catch {
    return false
  }
}

function onPath(binDir) {
  const entries = (process.env.PATH || '').split(delimiter).map((p) => resolve(p))
  return entries.includes(resolve(binDir))
}

const bins = resolveCliBins()
if (bins.length === 0) fail('no dist/ bin entries found in package.json')

const missing = bins.filter(({ target }) => !existsSync(target))
if (!uninstall && missing.length > 0) {
  fail(
    `${missing.map((b) => b.target.replace(packageRoot + '/', '')).join(', ')} not found — ` +
    `run \`pnpm run build:core\` first`,
  )
}

const binDir = resolveBinDir()
mkdirSync(binDir, { recursive: true })

const done = []
const skipped = []

for (const { name, target } of bins) {
  const linkPath = join(binDir, name)

  if (uninstall) {
    if (ownedByThisRepo(linkPath)) {
      rmSync(linkPath, { force: true })
      done.push(name)
    } else if (existsSync(linkPath)) {
      skipped.push(`${name} (not a link into this repo, left in place)`)
    }
    continue
  }

  if (existsSync(linkPath) || ownedByThisRepo(linkPath)) {
    if (!ownedByThisRepo(linkPath) && existsSync(linkPath)) {
      skipped.push(`${name} (already exists and is not ours, left in place)`)
      continue
    }
    rmSync(linkPath, { force: true })
  }

  chmodSync(target, 0o755)
  symlinkSync(target, linkPath)
  done.push(name)
}

if (uninstall) {
  process.stdout.write(
    `Unlinked gsd from ${binDir}\n` +
    `Removed: ${done.length ? done.join(', ') : '(nothing)'}\n` +
    (skipped.length ? `Skipped: ${skipped.join(', ')}\n` : ''),
  )
  process.exit(0)
}

process.stdout.write(
  `Linked gsd into ${binDir}\n` +
  `Linked: ${done.join(', ')}\n` +
  (skipped.length ? `Skipped: ${skipped.join(', ')}\n` : '') +
  `Targets ${join(packageRoot, 'dist', 'bootstrap.js')} — rebuild with ` +
  `\`pnpm run build:core\` to update.\n`,
)

if (!onPath(binDir)) {
  process.stdout.write(
    `\nWARNING: ${binDir} is not on your PATH. Add it, e.g.:\n` +
    `  export PATH="${binDir}:$PATH"\n`,
  )
}
