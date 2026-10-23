import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const requireFromRoot = createRequire(join(process.cwd(), 'package.json'));
const importOnly = new Map<string, boolean>();

function needsDynamicImport(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('@/')) return false;
  if (!importOnly.has(specifier)) {
    try {
      requireFromRoot.resolve(specifier);
      importOnly.set(specifier, false);
    } catch (error) {
      importOnly.set(specifier, (error as NodeJS.ErrnoException).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    }
  }
  return importOnly.get(specifier)!;
}

function violations(file: string, source: string): string[] {
  // Most files have no import-only dependency. Parse only candidate files.
  const specifiers = [...source.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)];
  if (!specifiers.some(match => needsDynamicImport(match[1]))) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return ast.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) return [];
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.every(element => element.isTypeOnly)) return [];
    } else {
      if (statement.isTypeOnly) return [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.every(element => element.isTypeOnly)) return [];
    }
    const specifier = statement.moduleSpecifier.text;
    return needsDynamicImport(specifier) ? [`${file}: ${specifier}`] : [];
  });
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sources(file)
      : /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

describe('CommonJS development host import boundary', () => {
  it('keeps import-only packages behind dynamic imports in runtime source', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).type).not.toBe('module');
    const files = [...sources('src/lib'), ...sources('src/app/api'), 'src/ws-server.ts'];
    expect(files.flatMap(file => violations(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('catches value imports and re-exports while allowing types and dynamic imports', () => {
    expect(violations('fixture.ts', `
      import { streamSimple } from '@earendil-works/pi-ai/compat';
      export { createModels } from '@earendil-works/pi-ai';
      import '@earendil-works/chord/context';
      import type { Model } from '@earendil-works/pi-ai';
      import { type Models } from '@earendil-works/pi-ai';
      export type { Message } from '@earendil-works/pi-ai';
      const sdk = await import('@earendil-works/pi-ai');
    `)).toEqual([
      'fixture.ts: @earendil-works/pi-ai/compat',
      'fixture.ts: @earendil-works/pi-ai',
      'fixture.ts: @earendil-works/chord/context',
    ]);
  });
});
