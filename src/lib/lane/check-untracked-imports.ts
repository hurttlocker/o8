import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { laneGitSync, LaneGitMetadataError } from '@/lib/lane/lane-git';

const SOURCE_FILE_PATTERN = /\.(ts|tsx)$/i;
const STATIC_IMPORT_PATTERN = /\b(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.d.ts'];

export interface UntrackedImportReference {
  importingFile: string;
  importSpecifier: string;
  untrackedFile: string;
}

export interface UntrackedImportCheckResult {
  ok: boolean;
  importingFiles: string[];
  references: UntrackedImportReference[];
  untrackedFiles: string[];
}

export function checkUntrackedImports(cwd: string, baseBranch: string, repoPath: string, runGit?: (args: string[]) => string): UntrackedImportCheckResult {
  const execute = runGit ?? ((args: string[]) => laneGitSync(cwd, repoPath, args, {
    timeout: 10_000, maxBuffer: 1024 * 1024,
  }));
  const untrackedFiles = getUntrackedFiles(execute);
  if (untrackedFiles.size === 0) {
    return {
      ok: true,
      importingFiles: [],
      references: [],
      untrackedFiles: [],
    };
  }

  const referencesByKey = new Map<string, UntrackedImportReference>();
  for (const importingFile of getChangedSourceFiles(baseBranch, execute)) {
    const importingPath = path.join(cwd, importingFile);
    if (!existsSync(importingPath)) {
      continue;
    }

    const source = readFileSync(importingPath, 'utf-8');
    for (const importSpecifier of extractImportSpecifiers(source)) {
      const resolvedFile = resolveImportPath(cwd, importingFile, importSpecifier);
      if (!resolvedFile || !untrackedFiles.has(resolvedFile)) {
        continue;
      }

      const key = `${importingFile}::${resolvedFile}`;
      if (!referencesByKey.has(key)) {
        referencesByKey.set(key, {
          importingFile,
          importSpecifier,
          untrackedFile: resolvedFile,
        });
      }
    }
  }

  const references = Array.from(referencesByKey.values())
    .sort((left, right) => {
      if (left.untrackedFile !== right.untrackedFile) {
        return left.untrackedFile.localeCompare(right.untrackedFile);
      }
      return left.importingFile.localeCompare(right.importingFile);
    });

  return {
    ok: references.length === 0,
    importingFiles: Array.from(new Set(references.map((reference) => reference.importingFile))).sort(),
    references,
    untrackedFiles: Array.from(new Set(references.map((reference) => reference.untrackedFile))).sort(),
  };
}

function getUntrackedFiles(execute: (args: string[]) => string): Set<string> {
  try {
    const output = execute(['ls-files', '--others', '--exclude-standard']).trim();

    return new Set(
      output
        .split('\n')
        .filter(Boolean)
        .map(normalizeRepoPath),
    );
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return new Set();
  }
}

function getChangedSourceFiles(baseBranch: string, execute: (args: string[]) => string): string[] {
  try {
    const output = execute(['diff', '--name-only', '--diff-filter=ACMR', `${baseBranch}...HEAD`]).trim();

    return output
      .split('\n')
      .filter(Boolean)
      .map(normalizeRepoPath)
      .filter((file) => SOURCE_FILE_PATTERN.test(file));
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    return [];
  }
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [STATIC_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]?.trim();
      if (specifier && isTrackedImportSpecifier(specifier)) {
        specifiers.add(specifier);
      }
    }
  }

  return Array.from(specifiers);
}

function isTrackedImportSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/');
}

function resolveImportPath(repoRoot: string, importingFile: string, importSpecifier: string): string | null {
  const importerPath = path.join(repoRoot, importingFile);
  const targetBasePath = importSpecifier.startsWith('@/')
    ? path.join(repoRoot, 'src', importSpecifier.slice(2))
    : path.resolve(path.dirname(importerPath), importSpecifier);

  for (const candidate of buildResolutionCandidates(targetBasePath, importSpecifier)) {
    if (!existsSync(candidate)) {
      continue;
    }

    return normalizeRepoPath(path.relative(repoRoot, candidate));
  }

  return null;
}

function buildResolutionCandidates(targetBasePath: string, importSpecifier: string): string[] {
  if (path.extname(importSpecifier)) {
    return [targetBasePath];
  }

  const directCandidates = RESOLUTION_EXTENSIONS.map((extension) => `${targetBasePath}${extension}`);
  const indexCandidates = RESOLUTION_EXTENSIONS.map((extension) => path.join(targetBasePath, `index${extension}`));
  return [...directCandidates, ...indexCandidates];
}

function normalizeRepoPath(filePath: string): string {
  return path.normalize(filePath).split(path.sep).join('/');
}
