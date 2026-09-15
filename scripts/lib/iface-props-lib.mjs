/**
 * Never-read interface properties: find `PropertySignature`s that are written
 * at least one site and read at none.
 *
 * See docs/dev/dead-code-lint.md and
 * docs/superpowers/specs/2026-09-15-never-read-interface-properties-design.md.
 */
import { relative } from 'node:path';
import ts from 'typescript';

export const DECLARATION_GLOBS = Object.freeze([
  'src/**/*.ts',
  'scripts/**/*.ts',
  'packages/contracts/src/**/*.ts',
  // packages/db has no package.json, so pnpm does not treat it as a workspace
  // and it has no src/ segment. knip.jsonc reaches it the same way.
  'packages/db/**/*.ts',
  'packages/gsd-agent-core/src/**/*.ts',
  'packages/gsd-agent-modes/src/**/*.ts',
  'packages/mcp-server/src/**/*.ts',
  'packages/native/src/**/*.ts',
  'packages/rpc-client/src/**/*.ts',
]);

// The vendored packages are in the program so that reads from them count
// against first-party declarations, but they never yield findings of their own:
// the pi boundary owns that tree and deleting code there fights upstream syncs.
export const PROGRAM_GLOBS = Object.freeze([...DECLARATION_GLOBS, 'packages/pi-*/src/**/*.ts']);

export const BASELINE_HEADER =
  'Accepted never-read interface properties as of the gate rollout. Never add to ' +
  'this list by hand: delete the property, or regenerate with ' +
  '`pnpm run lint:dead-code:props:update` when a finding moves for a legitimate ' +
  'reason. See docs/dev/dead-code-lint.md.';

export function createProgram(filePaths) {
  return ts.createProgram(filePaths, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });
}

const NAMED_ANCESTORS = [
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isClassDeclaration,
  ts.isFunctionDeclaration,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isPropertyDeclaration,
  ts.isVariableDeclaration,
  ts.isParameter,
];

export function ownerLabel(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (NAMED_ANCESTORS.some((is) => is(current)) && current.name && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return '<module>';
}

export function collectDeclarations(program, checker, isFirstParty, root) {
  const declarations = new Map();
  const used = new Set();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isFirstParty(sourceFile.fileName)) continue;
    const file = relative(root, sourceFile.fileName).split('\\').join('/');

    const visit = (node) => {
      if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol && !declarations.has(symbol)) {
          const name = node.name.text;
          const owner = ownerLabel(node);
          // Two anonymous literals can share an ancestor and a property name.
          // Suffixing keeps the key unique without reintroducing line numbers,
          // which would make moving code within a file read as a new finding.
          let key = `writeOnly|${file}|${owner}.${name}`;
          for (let index = 2; used.has(key); index += 1) {
            key = `writeOnly|${file}|${owner}.${name}#${index}`;
          }
          used.add(key);
          declarations.set(symbol, { name, file, owner, key });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return declarations;
}
