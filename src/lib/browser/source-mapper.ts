import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAttributeDescriptors,
  buildComponentDescriptors,
  buildStructureDescriptors,
  buildTextDescriptors,
} from '@/lib/browser/source-mapper-queries';
import type { PickedElement, SearchDescriptor, SourceMatch } from '@/lib/browser/source-mapper-types';

export type { PickedElement, SourceMatch } from '@/lib/browser/source-mapper-types';

type MatchReason = SourceMatch['matchReason'];

interface SearchHit {
  file: string;
  line: number;
  column: number;
}

interface FileComponentIndex {
  fallbackComponent: string;
  definitions: Array<{ name: string; line: number }>;
}

interface SearchContext {
  workspaceRoot: string;
  deadlineAt: number;
  callsUsed: number;
  componentIndexCache: Map<string, FileComponentIndex | null>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 5_000;
const MAX_GREP_CALLS = 10;
const MAX_MATCHES_PER_QUERY = 25;
const MAX_FINAL_MATCHES = 20;
const MAX_FILE_SIZE_BYTES = 100 * 1024;
const MAX_BUFFER_BYTES = 512 * 1024;
const SOURCE_FILE_GLOBS = ['*.tsx', '*.jsx'];
const EXCLUDED_GLOBS = ['!**/node_modules/**', '!**/.next/**', '!**/dist/**', '!**/.git/**'];
const MATCH_REASON_PRIORITY: Record<MatchReason, number> = {
  component_name: 5,
  text_content: 4,
  attribute: 3,
  class_name: 2,
  tag_structure: 1,
};

export async function findSourceMatches(element: PickedElement, workspace: string): Promise<SourceMatch[]> {
  const workspaceRoot = resolveWorkspaceRoot(workspace);
  if (!workspaceRoot) {
    return [];
  }

  const context: SearchContext = {
    workspaceRoot,
    deadlineAt: Date.now() + REQUEST_TIMEOUT_MS,
    callsUsed: 0,
    componentIndexCache: new Map(),
  };

  const rawMatches = [
    ...runSearchDescriptors(context, buildTextDescriptors(element)),
    ...runSearchDescriptors(context, buildAttributeDescriptors(element)),
    ...runSearchDescriptors(context, buildComponentDescriptors(element)),
    ...runSearchDescriptors(context, buildStructureDescriptors(element)),
  ];

  return finalizeMatches(context, rawMatches);
}

export function scoreMatch(baseConfidence: number, matchCount: number, textLength: number): number {
  let score = baseConfidence;
  if (matchCount === 1) score += 0.1;
  if (matchCount > 5) score -= 0.2;
  if (textLength > 30) score += 0.05;
  return Math.min(1, Math.max(0, score));
}

function resolveWorkspaceRoot(workspace: string) {
  const trimmed = workspace.trim();
  if (!trimmed) return null;

  const expanded = trimmed.replace(/^~(?=\/|$)/, os.homedir());
  const resolved = path.resolve(expanded);
  if (!existsSync(resolved)) return null;

  try {
    if (!statSync(resolved).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return resolved.replace(/\/+$/, '');
}

function runSearchDescriptors(context: SearchContext, descriptors: SearchDescriptor[]): SourceMatch[] {
  const matches: SourceMatch[] = [];

  for (const descriptor of descriptors) {
    if (!canSearch(context)) {
      break;
    }

    const hits = runSearch(context, descriptor);
    if (hits.length === 0) {
      continue;
    }

    const confidence = scoreMatch(descriptor.baseConfidence, hits.length, descriptor.textLength);
    for (const hit of hits) {
      matches.push({
        file: hit.file,
        line: hit.line,
        column: hit.column,
        component: descriptor.component ?? '',
        confidence,
        matchReason: descriptor.reason,
      });
    }
  }

  return matches;
}

function canSearch(context: SearchContext) {
  return context.callsUsed < MAX_GREP_CALLS && Date.now() < context.deadlineAt;
}

function runSearch(context: SearchContext, descriptor: SearchDescriptor): SearchHit[] {
  const timeout = Math.min(SEARCH_TIMEOUT_MS, context.deadlineAt - Date.now());
  if (timeout <= 0) {
    return [];
  }

  context.callsUsed += 1;

  try {
    const stdout = execFileSync('rg', buildRgArgs(descriptor), {
      cwd: context.workspaceRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return parseRgJson(stdout);
  } catch (error) {
    if (isNoMatchError(error)) {
      return [];
    }

    if (isMissingBinaryError(error)) {
      return runGrepFallback(context, descriptor, timeout);
    }

    console.warn('[source-map] Search failed', {
      reason: descriptor.reason,
      mode: descriptor.mode,
      query: descriptor.query.slice(0, 120),
      error: formatCommandError(error),
    });
    return [];
  }
}

function buildRgArgs(descriptor: SearchDescriptor) {
  const args = [
    '--json',
    '--line-number',
    '--max-count',
    String(MAX_MATCHES_PER_QUERY),
    '--max-filesize',
    '100K',
  ];

  for (const glob of SOURCE_FILE_GLOBS) {
    args.push('-g', glob);
  }
  for (const glob of EXCLUDED_GLOBS) {
    args.push('-g', glob);
  }

  args.push(descriptor.mode === 'fixed' ? '--fixed-strings' : '--pcre2');
  args.push('--', descriptor.query, '.');
  return args;
}

function runGrepFallback(context: SearchContext, descriptor: SearchDescriptor, timeout: number): SearchHit[] {
  try {
    const grepFlag = descriptor.mode === 'fixed' ? '-F' : '-E';
    // Use execFileSync with argv array — no shell, no injection risk
    const stdout = execFileSync('grep', [
      '-rnI', '-m', '1', grepFlag, '--',
      descriptor.query,
      '--include=*.tsx', '--include=*.jsx',
      '.',
    ], {
      cwd: context.workspaceRoot,
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return parseGrepOutput(stdout, descriptor);
  } catch (error) {
    if (isNoMatchError(error)) {
      return [];
    }

    console.warn('[source-map] Grep fallback failed', {
      reason: descriptor.reason,
      mode: descriptor.mode,
      query: descriptor.query.slice(0, 120),
      error: formatCommandError(error),
    });
    return [];
  }
}

function buildGrepCommand(descriptor: SearchDescriptor) {
  const grepFlag = descriptor.mode === 'fixed' ? '-F' : '-E';
  return [
    'find .',
    "-type d \\( -name node_modules -o -name .next -o -name dist -o -name .git \\) -prune -o",
    "-type f \\( -name '*.tsx' -o -name '*.jsx' \\) -size -102400c",
    `-exec grep -nI -m 1 ${grepFlag} -- ${quoteShell(descriptor.query)} {} +`,
  ].join(' ');
}

function parseRgJson(stdout: string): SearchHit[] {
  const hits: SearchHit[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          submatches?: Array<{ start?: number }>;
        };
      };
      if (parsed.type !== 'match' || !parsed.data?.path?.text || !parsed.data.line_number) {
        continue;
      }

      hits.push({
        file: stripLeadingDotSlash(parsed.data.path.text),
        line: parsed.data.line_number,
        column: (parsed.data.submatches?.[0]?.start ?? 0) + 1,
      });
    } catch {
      // Ignore malformed JSON lines from ripgrep.
    }
  }

  return hits;
}

function parseGrepOutput(stdout: string, descriptor: SearchDescriptor): SearchHit[] {
  const hits: SearchHit[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^(.*):(\d+):(.*)$/);
    if (!match) {
      continue;
    }

    const file = stripLeadingDotSlash(match[1] ?? '');
    const lineNumber = Number.parseInt(match[2] ?? '0', 10);
    const lineText = match[3] ?? '';
    if (!file || !lineNumber) {
      continue;
    }

    hits.push({
      file,
      line: lineNumber,
      column: descriptor.mode === 'fixed' ? Math.max(1, lineText.indexOf(descriptor.query) + 1) : 1,
    });
  }

  return hits;
}

function finalizeMatches(context: SearchContext, matches: SourceMatch[]) {
  const deduped = new Map<string, SourceMatch>();

  for (const match of matches) {
    const key = `${match.file}:${match.line}`;
    const enriched = {
      ...match,
      component: match.component || inferComponentName(context, match.file, match.line),
    };
    const existing = deduped.get(key);

    if (!existing) {
      deduped.set(key, enriched);
      continue;
    }

    const preferred = pickPreferredMatch(existing, enriched);
    deduped.set(key, {
      ...preferred,
      confidence: mergeConfidence(existing, enriched),
      component: preferred.component || existing.component || enriched.component,
    });
  }

  return Array.from(deduped.values())
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      if (MATCH_REASON_PRIORITY[right.matchReason] !== MATCH_REASON_PRIORITY[left.matchReason]) {
        return MATCH_REASON_PRIORITY[right.matchReason] - MATCH_REASON_PRIORITY[left.matchReason];
      }
      if (left.file !== right.file) {
        return left.file.localeCompare(right.file);
      }
      if (left.line !== right.line) {
        return left.line - right.line;
      }
      return left.column - right.column;
    })
    .slice(0, MAX_FINAL_MATCHES);
}

function pickPreferredMatch(left: SourceMatch, right: SourceMatch) {
  if (right.confidence !== left.confidence) {
    return right.confidence > left.confidence ? right : left;
  }
  if (MATCH_REASON_PRIORITY[right.matchReason] !== MATCH_REASON_PRIORITY[left.matchReason]) {
    return MATCH_REASON_PRIORITY[right.matchReason] > MATCH_REASON_PRIORITY[left.matchReason] ? right : left;
  }
  return right.column < left.column ? right : left;
}

function mergeConfidence(left: SourceMatch, right: SourceMatch) {
  const base = Math.max(left.confidence, right.confidence);
  if (left.matchReason === right.matchReason) {
    return base;
  }
  return Math.min(1, Math.round((base + 0.05) * 100) / 100);
}

function inferComponentName(context: SearchContext, relativeFile: string, line: number) {
  const index = getFileComponentIndex(context, relativeFile);
  if (!index) {
    return '';
  }

  const priorDefinitions = index.definitions.filter((definition) => definition.line <= line);
  if (priorDefinitions.length > 0) {
    return priorDefinitions[priorDefinitions.length - 1]?.name ?? index.fallbackComponent;
  }

  return index.definitions[0]?.name ?? index.fallbackComponent;
}

function getFileComponentIndex(context: SearchContext, relativeFile: string) {
  if (context.componentIndexCache.has(relativeFile)) {
    return context.componentIndexCache.get(relativeFile) ?? null;
  }

  const absolutePath = path.resolve(context.workspaceRoot, relativeFile);
  // Guard against path traversal — resolved path must stay within workspace
  if (!absolutePath.startsWith(context.workspaceRoot + path.sep)) {
    context.componentIndexCache.set(relativeFile, null);
    return null;
  }
  if (!existsSync(absolutePath)) {
    context.componentIndexCache.set(relativeFile, null);
    return null;
  }

  try {
    const stats = statSync(absolutePath);
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      context.componentIndexCache.set(relativeFile, null);
      return null;
    }

    const definitions: Array<{ name: string; line: number }> = [];
    for (const [index, rawLine] of readFileSync(absolutePath, 'utf8').split(/\r?\n/).entries()) {
      const match = rawLine.match(
        /\b(?:export\s+default\s+function|function|const|class)\s+([A-Z][A-Za-z0-9_]*)\b|\bexport\s+default\s+([A-Z][A-Za-z0-9_]*)\b/,
      );
      const name = match?.[1] ?? match?.[2];
      if (name) {
        definitions.push({ name, line: index + 1 });
      }
    }

    const basename = path.basename(relativeFile, path.extname(relativeFile));
    const index = {
      fallbackComponent: /^[A-Z][A-Za-z0-9_]*$/.test(basename) ? basename : '',
      definitions,
    };
    context.componentIndexCache.set(relativeFile, index);
    return index;
  } catch {
    context.componentIndexCache.set(relativeFile, null);
    return null;
  }
}

function isNoMatchError(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && (error as { status?: number }).status === 1;
}

function isMissingBinaryError(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

function quoteShell(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function stripLeadingDotSlash(value: string) {
  return value.startsWith('./') ? value.slice(2) : value;
}

function formatCommandError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
