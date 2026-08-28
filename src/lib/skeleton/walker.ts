/**
 * Skeleton Map — Repository file walker.
 *
 * Uses `git ls-files` for gitignore-aware file listing.
 * Falls back to manual traversal for non-git repos.
 */

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { ScanOptions, SupportedLanguage } from './types';

export interface WalkedFile {
  relativePath: string;
  absolutePath: string;
  language: SupportedLanguage;
}

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.rs': 'rust',
  '.json': 'json',
  '.md': 'markdown',
};

const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_MAP));

/** Patterns to skip (test files, generated files). */
const TEST_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /__tests__\//,
  /\.stories\.[tj]sx?$/,
];

const SKIP_PATTERNS = [
  /\.d\.ts$/,
  /\.min\./,
  /\/node_modules\//,
  /\/.next\//,
  /\/target\//,
  /\/dist\//,
  /\/build\//,
  /\/out\//,
  /\/drizzle\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = extname(filePath);
  return EXTENSION_MAP[ext] ?? null;
}

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some(p => p.test(filePath));
}

function shouldSkip(filePath: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(filePath));
}

/**
 * Walk a repository and return supported source files.
 * Uses `git ls-files` for gitignore awareness.
 */
export function walkRepo(options: ScanOptions): WalkedFile[] {
  const {
    repoPath,
    maxFiles = 2000,
    maxFileSize = 200 * 1024,
    includeTests = false,
  } = options;

  let fileList: string[];

  try {
    const raw = execSync(
      'git ls-files --cached --others --exclude-standard',
      { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    ).trim();
    fileList = raw ? raw.split('\n') : [];
  } catch {
    console.warn('[skeleton] git ls-files failed, skipping repo:', repoPath);
    return [];
  }

  const results: WalkedFile[] = [];

  for (const relativePath of fileList) {
    if (results.length >= maxFiles) break;

    const ext = extname(relativePath);
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    if (shouldSkip(relativePath)) continue;
    if (!includeTests && isTestFile(relativePath)) continue;

    const language = detectLanguage(relativePath);
    if (!language) continue;

    const absolutePath = join(repoPath, relativePath);

    // Check file size
    try {
      const stat = statSync(absolutePath);
      if (stat.size > maxFileSize) continue;
    } catch {
      continue;
    }

    results.push({ relativePath, absolutePath, language });
  }

  console.log(`[skeleton] Walked ${repoPath}: ${results.length} files (of ${fileList.length} tracked)`);
  return results;
}
