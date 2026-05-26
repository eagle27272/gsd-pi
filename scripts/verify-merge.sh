#!/usr/bin/env bash
# Local parity with CI PR merge gates (ci.yml blocking jobs when heavy-code-changed).
# See docs/dev/test-confidence-stack.md for the full tier map.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "── verify:merge (CI PR blocking parity) ──"

echo "── build:core ──"
npm run build:core

echo "── web host (required by validate-pack) ──"
npm --prefix web ci
npm run build:web-host

echo "── typecheck:extensions ──"
npm run typecheck:extensions

echo "── validate-pack ──"
npm run validate-pack

echo "── verify:workspace-coverage ──"
npm run verify:workspace-coverage

echo "── verify:extension-coverage ──"
npm run verify:extension-coverage

echo "── test:unit ──"
npm run test:unit

echo "── test:packages ──"
npm run test:packages

echo "── test:integration ──"
npm run test:integration

echo "── test:e2e ──"
chmod +x dist/loader.js
export GSD_SMOKE_BINARY="${ROOT}/dist/loader.js"
npm run test:e2e

echo "verify:merge: all checks passed ✓"
