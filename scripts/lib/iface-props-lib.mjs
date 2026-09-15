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

// Walking straight to the nearest NAMED_ANCESTORS match skips over any
// PropertySignatures in between, collapsing `R.cost.total` and `R.duration`
// onto the same shape. Collecting each intervening property name keeps the
// nesting path visible in the key.
export function ownerLabel(node) {
  const path = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertySignature(current) && (ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name))) {
      path.unshift(current.name.text);
    } else if (NAMED_ANCESTORS.some((is) => is(current)) && current.name && ts.isIdentifier(current.name)) {
      path.unshift(current.name.text);
      return path.join('.');
    }
  }
  return ['<module>', ...path].join('.');
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

// `=` stores without loading. Every other assignment operator, and ++/--, reads
// the old value first.
function isPlainAssignmentTarget(node) {
  return (
    ts.isBinaryExpression(node.parent) &&
    node.parent.left === node &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function rootsOf(checker, symbol) {
  return symbol ? [symbol, ...(checker.getRootSymbols(symbol) ?? [])] : [];
}

// Resolve a property name against a type, descending into unions and
// intersections so a key satisfying `A | B` links to the declaration in both.
function propertiesOfType(checker, type, name) {
  if (!type) return [];
  const found = [];
  const direct = checker.getPropertyOfType(type, name);
  if (direct) found.push(direct);
  if (type.isUnionOrIntersection?.()) {
    for (const constituent of type.types) {
      const property = checker.getPropertyOfType(constituent, name);
      if (property) found.push(property);
    }
  }
  return found.flatMap((symbol) => rootsOf(checker, symbol));
}

export function classifyReferences(program, checker) {
  const readNames = new Set();
  const writeSymbols = new Set();

  const markRead = (symbols) => {
    for (const symbol of symbols) readNames.add(symbol.getName());
  };
  const markWritten = (symbols) => {
    for (const symbol of symbols) writeSymbols.add(symbol);
  };
  const markAllPropertiesRead = (type) => {
    if (type) markRead(checker.getPropertiesOfType(type) ?? []);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const symbols = rootsOf(checker, checker.getSymbolAtLocation(node.name));
        if (isPlainAssignmentTarget(node)) markWritten(symbols);
        else markRead(symbols);
      } else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const type = checker.getTypeAtLocation(node.expression);
        markRead(propertiesOfType(checker, type, node.argumentExpression.text));
      } else if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const contextual = checker.getContextualType(node.parent);
        markWritten(propertiesOfType(checker, contextual, node.name.text));
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const type = checker.getTypeAtLocation(node.parent);
        // `...rest` carries every property the pattern didn't name onward,
        // same as a spread in an object literal, so it gets the same
        // mark-everything treatment rather than a lookup by `rest`'s own name.
        if (node.dotDotDotToken) markAllPropertiesRead(type);
        else markRead(propertiesOfType(checker, type, (node.propertyName ?? node.name).getText()));
      } else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) {
        markAllPropertiesRead(checker.getTypeAtLocation(node.expression));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { readNames, writeSymbols };
}

/**
 * A property is dead when it is written somewhere and no property of that name
 * is read anywhere in the program.
 *
 * Reads are matched by name rather than by symbol because TypeScript is
 * structurally typed: a read through a compatible-but-separate interface never
 * links back to this declaration. Keying on the symbol turns ~190 findings into
 * ~1800, nearly all of them reads the join simply could not see. The cost is
 * recall — a same-named property on an unrelated type that *is* read masks a
 * genuine finding — which is the right trade for a gate wired into CI.
 */
export function findWriteOnly(declarations, references) {
  const keys = [];
  for (const [symbol, info] of declarations) {
    if (references.readNames.has(info.name)) continue;
    if (!references.writeSymbols.has(symbol)) continue;
    keys.push(info.key);
  }
  return keys.sort();
}

export function analyse(filePaths, isFirstParty, root) {
  const program = createProgram(filePaths);
  const checker = program.getTypeChecker();
  const declarations = collectDeclarations(program, checker, isFirstParty, root);
  return findWriteOnly(declarations, classifyReferences(program, checker));
}
