#!/usr/bin/env node
/** Restore GSD tsc tsconfig.json for vendored pi packages, dropping upstream's stale build configs. */
'use strict'

const { writeFileSync, existsSync, rmSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const ROOT = join(__dirname, '..')
const PACKAGES = ['pi-agent-core', 'pi-ai', 'pi-tui']

// Upstream ships these extending a tsconfig.base.json GSD does not have. Left in place they are a
// trap: creating that filename at the root would silently activate upstream's options against
// packages that have since diverged. GSD builds via tsconfig.json, so drop them. See #82.
const STALE_VENDORED_CONFIGS = [
  ['pi-agent-core', 'tsconfig.build.json'],
  ['pi-ai', 'tsconfig.build.json'],
  ['pi-tui', 'tsconfig.build.json'],
  ['pi-coding-agent', 'tsconfig.build.json'],
  ['pi-coding-agent', 'tsconfig.examples.json'],
]

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2024',
    module: 'Node16',
    lib: ['ES2024'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    incremental: false,
    forceConsistentCasingInFileNames: true,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    inlineSources: true,
    inlineSourceMap: false,
    moduleResolution: 'Node16',
    resolveJsonModule: true,
    allowImportingTsExtensions: false,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    useDefineForClassFields: false,
    types: ['node'],
    outDir: './dist',
    rootDir: './src',
  },
  include: ['src/**/*'],
  exclude: ['node_modules', 'dist'],
}

for (const pkg of PACKAGES) {
  const dest = join(ROOT, 'packages', pkg, 'tsconfig.json')
  let config = TSCONFIG
  try {
    config = JSON.parse(
      execSync(`git show HEAD:packages/${pkg}/tsconfig.json`, { cwd: ROOT, encoding: 'utf8' }),
    )
    if (config.compilerOptions) config.compilerOptions.incremental = false
  } catch {
    /* use default */
  }
  writeFileSync(dest, JSON.stringify(config, null, 2) + '\n')
}

for (const [pkg, file] of STALE_VENDORED_CONFIGS) {
  const path = join(ROOT, 'packages', pkg, file)
  if (!existsSync(path)) continue
  rmSync(path)
  process.stderr.write(`restore-pi-tsconfig: ${pkg} (removed vendored ${file})\n`)
}

process.stderr.write('restore-pi-tsconfig: done\n')
