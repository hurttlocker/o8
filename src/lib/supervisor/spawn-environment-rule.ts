import { posix } from 'node:path';
import ts from 'typescript';
import type { RuleViolation } from './rule-check';

const RAW_BOUNDARY = 'src/lib/providers/child-process.ts';
const ENVIRONMENT_BUILDER = 'src/lib/providers/spawn-environment.ts';
const METHODS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
type Origin = 'node' | 'wrapper' | 'pty' | 'process' | 'environment' | `call:${string}:${string}`;

function moduleOrigin(name: string): Origin | undefined {
  if (name === 'child_process' || name === 'node:child_process') return 'node';
  if (name === 'node-pty') return 'pty';
  if (name === 'process' || name === 'node:process') return 'process';
  return undefined;
}

function propertyName(node: ts.Node | undefined): string | undefined {
  if (node && ts.isComputedPropertyName(node)) return propertyName(node.expression);
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

/** Security invariants scan the complete changed file, independently of diff lines. */
export function scanSpawnEnvironment(relPath: string, content: string): RuleViolation[] {
  if (!relPath.startsWith('src/')) return [];
  const originForModule = (name: string): Origin | undefined => {
    const resolved = name.startsWith('@/') ? `src/${name.slice(2)}`
      : name.startsWith('.') ? posix.normalize(posix.join(posix.dirname(relPath), name)) : name;
    if (resolved.replace(/\.(?:ts|js)$/, '') === RAW_BOUNDARY.replace(/\.ts$/, '')) return 'wrapper';
    return moduleOrigin(name);
  };
  const source = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // A no-resolve in-memory program binds local symbols (including shadowed names)
  // without reading dependencies or needing the repository's compiler settings.
  const program = ts.createProgram([relPath], { noResolve: true, noLib: true }, {
    getSourceFile: name => name === relPath ? source : undefined,
    getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
    getDirectories: () => [], fileExists: name => name === relPath,
    readFile: name => name === relPath ? content : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  });
  const checker = program.getTypeChecker();
  const assignments = new Map<ts.Symbol, ts.Expression[]>();
  const collectAssignments = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) assignments.set(symbol, [...(assignments.get(symbol) ?? []), node.right]);
    }
    ts.forEachChild(node, collectAssignments);
  };
  collectAssignments(source);
  const violations: RuleViolation[] = [];
  const report = (node: ts.Node, rule: RuleViolation['rule'], detail: string) => {
    violations.push({ file: relPath, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, detail });
  };

  function moduleName(node: ts.Node): string | undefined {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) return node.moduleSpecifier.text;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      return node.moduleReference.expression.text;
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) return node.arguments[0].text;
    return undefined;
  }

  function member(origin: Origin | undefined, key: string | undefined): Origin | undefined {
    if (origin === 'process' && key === 'env') return 'environment';
    if ((origin === 'node' || origin === 'wrapper' || origin === 'pty') && key && METHODS.has(key)) {
      return `call:${origin}:${key}`;
    }
    return undefined;
  }

  function initializer(node: ts.Identifier): ts.Expression | undefined {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)) return declaration.initializer;
    return undefined;
  }

  function parameterOrigin(declaration: ts.ParameterDeclaration, seen: Set<ts.Node>): Origin | undefined {
    if (relPath === 'src/lib/ws-server/terminal-host-client.ts'
      && declaration.type && ts.isTypeReferenceNode(declaration.type)
      && ts.isIdentifier(declaration.type.typeName) && declaration.type.typeName.text === 'InlinePtyModule') return 'pty';
    const callback = declaration.parent;
    if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters[0] === declaration
      && ts.isCallExpression(callback.parent) && ts.isPropertyAccessExpression(callback.parent.expression)
      && callback.parent.expression.name.text === 'then') {
      return originOf(callback.parent.expression.expression, seen);
    }
    return undefined;
  }

  function originOf(expression: ts.Expression, seen = new Set<ts.Node>()): Origin | undefined {
    const node = unwrap(expression);
    if (seen.has(node)) return undefined;
    const next = new Set(seen).add(node);
    const importedModule = moduleName(node);
    if (importedModule) return originForModule(importedModule);
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      if (!symbol && node.text === 'process') return 'process';
      const declaration = symbol?.declarations?.[0];
      if (!declaration) return undefined;
      if (ts.isImportSpecifier(declaration)) {
        const clause = declaration.parent.parent;
        if (declaration.isTypeOnly || clause.isTypeOnly) return undefined;
        return member(originForModule(moduleName(clause.parent) ?? ''), (declaration.propertyName ?? declaration.name).text);
      }
      if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) {
        const clause = ts.isImportClause(declaration) ? declaration : declaration.parent;
        return clause.isTypeOnly ? undefined : originForModule(moduleName(clause.parent) ?? '');
      }
      if (ts.isImportEqualsDeclaration(declaration)) return originForModule(moduleName(declaration) ?? '');
      if (ts.isParameter(declaration)) return parameterOrigin(declaration, next);
      if (ts.isVariableDeclaration(declaration)) {
        const values = [...(declaration.initializer ? [declaration.initializer] : []), ...(symbol ? assignments.get(symbol) ?? [] : [])];
        for (const value of values) {
          const origin = originOf(value, next);
          if (origin) return origin;
        }
      }
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const parent = declaration.parent.parent;
        if (ts.isParameter(parent)) return member(parameterOrigin(parent, next), propertyName(declaration.propertyName ?? declaration.name));
        if (ts.isVariableDeclaration(parent) && parent.initializer) {
          return member(originOf(parent.initializer, next), propertyName(declaration.propertyName ?? declaration.name));
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) return member(originOf(node.expression, next), node.name.text);
    if (ts.isElementAccessExpression(node)) return member(originOf(node.expression, next), propertyName(node.argumentExpression));
    return undefined;
  }

  function containsRawEnvironment(expression: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const node = unwrap(expression);
    if (seen.has(node)) return false;
    const next = new Set(seen).add(node);
    if (originOf(node) === 'environment') return true;
    // Reading one scalar (for example PATH) does not inherit the env object.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && originOf(node.expression) === 'environment') return false;
    if (ts.isIdentifier(node)) {
      const value = initializer(node);
      const symbol = checker.getSymbolAtLocation(node);
      return [...(value ? [value] : []), ...(symbol ? assignments.get(symbol) ?? [] : [])]
        .some(candidate => containsRawEnvironment(candidate, next));
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
    let found = false;
    const inspect = (child: ts.Node): void => {
      if (ts.isExpression(child)) {
        if (containsRawEnvironment(child, next)) found = true;
      } else {
        ts.forEachChild(child, inspect);
      }
    };
    ts.forEachChild(node, inspect);
    return found;
  }

  function envProperty(expression: ts.Expression, seen = new Set<ts.Node>()): ts.Expression | undefined {
    const node = unwrap(expression);
    if (seen.has(node)) return undefined;
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const value = initializer(node);
      return value ? envProperty(value, next) : undefined;
    }
    if (!ts.isObjectLiteralExpression(node)) return undefined;
    let env: ts.Expression | undefined;
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) env = envProperty(property.expression, next) ?? env;
      else if (propertyName(property.name) === 'env') {
        if (ts.isPropertyAssignment(property)) env = property.initializer;
        if (ts.isShorthandPropertyAssignment(property)) {
          const declaration = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
          env = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : property.name;
        }
      }
    }
    return env;
  }

  function visit(node: ts.Node): void {
    const importedModule = moduleName(node);
    if (importedModule && originForModule(importedModule) === 'node' && relPath !== RAW_BOUNDARY) {
      const typeOnly = (ts.isImportDeclaration(node) && node.importClause
        && (node.importClause.isTypeOnly || (!node.importClause.name && node.importClause.namedBindings
          && ts.isNamedImports(node.importClause.namedBindings)
          && node.importClause.namedBindings.elements.length > 0
          && node.importClause.namedBindings.elements.every(specifier => specifier.isTypeOnly))))
        || (ts.isImportEqualsDeclaration(node) && node.isTypeOnly)
        || (ts.isExportDeclaration(node) && (node.isTypeOnly || (node.exportClause
          && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0
          && node.exportClause.elements.every(specifier => specifier.isTypeOnly))));
      if (!typeOnly) report(node, 'child-process-boundary',
        'Use the typed providers/child-process wrapper. Only that module may import Node child_process values.');
    }
    if (ts.isCallExpression(node)) {
      const origin = originOf(node.expression);
      if (origin?.startsWith('call:')) {
        const [, boundary, method] = origin.split(':');
        // exec/execSync take options second; other Node methods and PTY spawn
        // accept an optional args array before options. Checking both optional
        // positions also detects overloads with a callback after options.
        const candidates = method === 'exec' || method === 'execSync'
          ? node.arguments.slice(1, 2) : node.arguments.slice(1, 3);
        const environments = candidates.map(candidate => envProperty(candidate)).filter((env): env is ts.Expression => !!env);
        if (relPath !== ENVIRONMENT_BUILDER && candidates.some(candidate => containsRawEnvironment(candidate))) {
          report(node, 'spawn-environment', 'Build the child environment with providers/spawn-environment; raw process.env can restore stale provider credentials.');
        } else if ((boundary === 'node' || boundary === 'pty') && (environments.length === 0
          || environments.some(env => env.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(env) && env.text === 'undefined')))) {
          report(node, 'spawn-environment', 'Pass an explicit policy-checked env at the raw process boundary; omitted env inherits process.env.');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return violations;
}
