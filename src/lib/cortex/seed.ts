/**
 * Cortex seeding helpers.
 *
 * Imports useful project context into Cortex memory from a codebase,
 * git history, or manual text.
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DOC_LIMIT = 10;
const DEFAULT_OK_RECOMMENDATION = '';

const CODEBASE_PRIORITY_FILES = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.cortexrules',
  '.cursorrules',
  '.clinerules',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
] as const;

const COMMIT_NOISE_PATTERNS = [
  /fix\s+typo/i,
  /(^|\W)wip(\W|$)/i,
  /(^|\W)merge(\W|$)/i,
  /^chore:\s*bump/i,
  /update\s+deps?/i,
  /format(?:ting)?/i,
  /^bump\b/i,
] as const;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface ImportResult {
  ok: boolean;
  factsCreated: number;
  output: string;
}

interface SeedTarget {
  kind: 'file' | 'text';
  filePath: string;
  label: string;
  text?: string;
  source?: string;
}

interface PullRequestSummary {
  title?: string;
  body?: string;
  mergedAt?: string | null;
}

let cortexBinaryPromise: Promise<string | null> | null = null;

function expandHomePath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'seed';
}

function combineOutput(result: ExecResult): string {
  return [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
}

function formatSummaryValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => String(item)).join(', ');
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).join(', ');
  }
  return String(value);
}

function parseJsonCount(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const candidateKeys = [
    'factsCreated',
    'facts_created',
    'factsExtracted',
    'facts_extracted',
    'extracted',
    'facts',
    'imported',
    'memories',
  ];

  for (const key of candidateKeys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
      return Number(candidate.trim());
    }
  }

  return null;
}

function collectRegexCounts(text: string, patterns: RegExp[]): number[] {
  const counts: number[] = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        counts.push(value);
      }
    }
  }

  return counts;
}

function parseFactsCreated(output: string): number {
  if (!output.trim()) return 0;

  try {
    const parsed = JSON.parse(output);
    const count = parseJsonCount(parsed);
    if (count !== null) return count;
  } catch {
    // ignore non-JSON output
  }

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const count = parseJsonCount(parsed);
      if (count !== null) return count;
    } catch {
      // ignore partial lines
    }
  }

  const factCounts = collectRegexCounts(output, [
    /facts?_extracted[=:]\s*(\d+)/gi,
    /facts extracted:\s*(\d+)/gi,
    /extracted\s+(\d+)\s+facts?/gi,
    /(\d+)\s+facts?\s+extracted/gi,
  ]);
  if (factCounts.length > 0) {
    return Math.max(...factCounts);
  }

  const importCounts = collectRegexCounts(output, [
    /imported\s+(\d+)\s+memories?/gi,
    /import summary:[^\n]*imported=(\d+)/gi,
    /imported\s+(\d+),\s*denied/gi,
    /memories:\s*(\d+)\s+new/gi,
  ]);
  if (importCounts.length > 0) {
    return Math.max(...importCounts);
  }

  return 0;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runExecFile(
  file: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout,
          stderr,
          error: error instanceof Error ? error.message : undefined,
        });
      },
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

async function resolveCortexBinary(): Promise<string | null> {
  if (cortexBinaryPromise) return cortexBinaryPromise;

  cortexBinaryPromise = (async () => {
    const preferred = path.join(os.homedir(), 'bin', 'cortex');
    if (await isExecutable(preferred)) {
      return preferred;
    }

    const configured = process.env.CORTEX_BINARY?.trim();
    if (configured && await isExecutable(configured)) {
      return configured;
    }

    const whichResult = await runExecFile('which', ['cortex'], { timeoutMs: 2_000 });
    const found = whichResult.stdout.trim().split(/\r?\n/).find(Boolean)?.trim();
    return found || null;
  })();

  return cortexBinaryPromise;
}

async function runCortex(
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const binary = await resolveCortexBinary();
  if (!binary) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      error: 'Cortex binary not found',
    };
  }

  return runExecFile(binary, args, options);
}

async function importFile(filePath: string): Promise<ImportResult> {
  const result = await runCortex(['import', filePath, '--extract'], { timeoutMs: EXEC_TIMEOUT_MS });
  const output = combineOutput(result);
  return {
    ok: result.ok,
    factsCreated: parseFactsCreated(output),
    output,
  };
}

async function importText(text: string, source = 'manual-text'): Promise<ImportResult> {
  const normalized = text.trim();
  if (!normalized) {
    return { ok: false, factsCreated: 0, output: 'Nothing to import' };
  }

  const stdinResult = await runCortex(
    ['import', '--extract', '--source', source, '--stdin'],
    { input: normalized, timeoutMs: EXEC_TIMEOUT_MS },
  );

  if (stdinResult.ok) {
    const output = combineOutput(stdinResult);
    return {
      ok: true,
      factsCreated: parseFactsCreated(output),
      output,
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cortex-seed-'));
  try {
    const tempFile = path.join(tempDir, `${slugify(source)}.md`);
    const wrapped = source
      ? `# ${source}\n\n${normalized}\n`
      : `${normalized}\n`;

    await writeFile(tempFile, wrapped, 'utf-8');

    const fallbackResult = await runCortex(['import', tempFile, '--extract'], { timeoutMs: EXEC_TIMEOUT_MS });
    const fallbackOutput = combineOutput(fallbackResult) || combineOutput(stdinResult);

    return {
      ok: fallbackResult.ok,
      factsCreated: parseFactsCreated(fallbackOutput),
      output: fallbackOutput,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function makeProjectSummary(repoPath: string, raw: string): string | null {
  try {
    const pkg = JSON.parse(stripJsonComments(raw)) as {
      name?: string;
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    const dependencies = [...new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])];
    const scripts = Object.keys(pkg.scripts ?? {});
    const parts = [`Project: ${pkg.name ?? path.basename(repoPath)}.`];

    if (pkg.description?.trim()) {
      parts.push(`Description: ${normalizeWhitespace(pkg.description)}.`);
    }

    parts.push(`Dependencies: ${dependencies.length > 0 ? dependencies.join(', ') : 'none'}.`);
    parts.push(`Scripts: ${scripts.length > 0 ? scripts.join(', ') : 'none'}.`);

    return parts.join(' ');
  } catch {
    return null;
  }
}

function makeTsconfigSummary(raw: string): string | null {
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as {
      extends?: string;
      compilerOptions?: Record<string, unknown>;
      include?: unknown;
      exclude?: unknown;
    };

    const compilerOptions = parsed.compilerOptions ?? {};
    const priorityKeys = [
      'target',
      'module',
      'moduleResolution',
      'jsx',
      'strict',
      'baseUrl',
      'rootDir',
      'outDir',
      'types',
      'lib',
      'paths',
      'allowJs',
      'noEmit',
      'incremental',
      'resolveJsonModule',
      'esModuleInterop',
    ];

    const optionsSummary = priorityKeys
      .filter(key => compilerOptions[key] !== undefined)
      .map(key => `${key}=${formatSummaryValue(compilerOptions[key])}`);

    const parts = ['TypeScript configuration summary.'];
    if (parsed.extends) {
      parts.push(`Extends: ${parsed.extends}.`);
    }
    parts.push(`Compiler options: ${optionsSummary.length > 0 ? optionsSummary.join('; ') : 'none specified'}.`);

    if (Array.isArray(parsed.include) && parsed.include.length > 0) {
      parts.push(`Include: ${parsed.include.join(', ')}.`);
    }
    if (Array.isArray(parsed.exclude) && parsed.exclude.length > 0) {
      parts.push(`Exclude: ${parsed.exclude.join(', ')}.`);
    }

    return parts.join(' ');
  } catch {
    return null;
  }
}

function makeEnvSummary(raw: string): string | null {
  const names = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((name): name is string => Boolean(name));

  const unique = [...new Set(names)];
  if (unique.length === 0) return null;

  return `Environment variables expected by this project: ${unique.join(', ')}.`;
}

async function collectCodebaseTargets(repoPath: string): Promise<SeedTarget[]> {
  const targets: SeedTarget[] = [];

  for (const relativePath of CODEBASE_PRIORITY_FILES) {
    const absolutePath = path.join(repoPath, relativePath);
    if (await pathExists(absolutePath)) {
      targets.push({
        kind: 'file',
        filePath: absolutePath,
        label: relativePath,
      });
    }
  }

  const docsDir = path.join(repoPath, 'docs');
  try {
    const docsEntries = await readdir(docsDir, { withFileTypes: true });
    const docFiles = docsEntries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, DOC_LIMIT);

    for (const filename of docFiles) {
      targets.push({
        kind: 'file',
        filePath: path.join(docsDir, filename),
        label: path.join('docs', filename),
      });
    }
  } catch {
    // docs/ is optional
  }

  const packagePath = path.join(repoPath, 'package.json');
  if (await pathExists(packagePath)) {
    try {
      const summary = makeProjectSummary(repoPath, await readFile(packagePath, 'utf-8'));
      targets.push(summary
        ? {
            kind: 'text',
            filePath: packagePath,
            label: 'package.json',
            text: summary,
            source: 'package-json',
          }
        : {
            kind: 'file',
            filePath: packagePath,
            label: 'package.json',
          });
    } catch {
      targets.push({
        kind: 'file',
        filePath: packagePath,
        label: 'package.json',
      });
    }
  }

  const tsconfigPath = path.join(repoPath, 'tsconfig.json');
  if (await pathExists(tsconfigPath)) {
    try {
      const summary = makeTsconfigSummary(await readFile(tsconfigPath, 'utf-8'));
      targets.push(summary
        ? {
            kind: 'text',
            filePath: tsconfigPath,
            label: 'tsconfig.json',
            text: summary,
            source: 'tsconfig-json',
          }
        : {
            kind: 'file',
            filePath: tsconfigPath,
            label: 'tsconfig.json',
          });
    } catch {
      targets.push({
        kind: 'file',
        filePath: tsconfigPath,
        label: 'tsconfig.json',
      });
    }
  }

  const envExamplePath = path.join(repoPath, '.env.example');
  if (await pathExists(envExamplePath)) {
    try {
      const summary = makeEnvSummary(await readFile(envExamplePath, 'utf-8'));
      if (summary) {
        targets.push({
          kind: 'text',
          filePath: envExamplePath,
          label: '.env.example',
          text: summary,
          source: 'env-example',
        });
      }
    } catch {
      // ignore unreadable env example files
    }
  }

  return targets;
}

function isMeaningfulCommit(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 10) return false;
  return !COMMIT_NOISE_PATTERNS.some(pattern => pattern.test(trimmed));
}

function formatPullRequestSummary(pr: PullRequestSummary): string | null {
  const title = pr.title?.trim();
  const body = normalizeWhitespace(pr.body ?? '');

  if (!title || !body) return null;
  if (/\bbump\b/i.test(title) || /\bbump\b/i.test(body)) return null;

  const suffix = pr.mergedAt ? ` (merged ${pr.mergedAt.slice(0, 10)})` : '';
  return `- ${title}${suffix}: ${body.slice(0, 500)}`;
}

export async function seedFromCodebase(
  repoPath: string,
  onProgress?: (msg: string) => void,
): Promise<{ factsCreated: number; filesScanned: number }> {
  const resolvedRepoPath = path.resolve(expandHomePath(repoPath));
  const targets = await collectCodebaseTargets(resolvedRepoPath).catch(() => []);

  let factsCreated = 0;
  let filesScanned = 0;

  for (const target of targets) {
    onProgress?.(`Scanning ${target.label}...`);

    const result = target.kind === 'text' && target.text
      ? await importText(target.text, target.source ?? target.label)
      : await importFile(target.filePath);

    filesScanned += 1;
    factsCreated += result.factsCreated;

    if (result.ok) {
      onProgress?.(`Imported ${result.factsCreated} facts from ${target.label}`);
    } else {
      const reason = normalizeWhitespace(result.output || 'Import failed');
      onProgress?.(`Skipped ${target.label}: ${reason}`);
    }
  }

  return { factsCreated, filesScanned };
}

export async function seedFromGitHistory(
  repoPath: string,
  onProgress?: (msg: string) => void,
): Promise<{ factsCreated: number; commitsProcessed: number }> {
  const resolvedRepoPath = path.resolve(expandHomePath(repoPath));
  let factsCreated = 0;
  let commitsProcessed = 0;

  const gitLog = await runExecFile('git', ['log', '--oneline', '--no-merges', '-100'], {
    cwd: resolvedRepoPath,
    timeoutMs: EXEC_TIMEOUT_MS,
  });

  const meaningfulCommits = gitLog.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[0-9a-f]+\s+/i, '').trim())
    .filter(isMeaningfulCommit);

  commitsProcessed = meaningfulCommits.length;

  if (meaningfulCommits.length > 0) {
    onProgress?.(`Importing ${meaningfulCommits.length} commit summaries...`);
    const commitSummary = [
      'Recent project decisions and changes:',
      ...meaningfulCommits.map(message => `- ${message}`),
    ].join('\n');

    const commitImport = await importText(commitSummary, 'git-history');
    factsCreated += commitImport.factsCreated;
    if (commitImport.ok) {
      onProgress?.(`Imported ${commitImport.factsCreated} facts from git history`);
    }
  } else if (!gitLog.ok) {
    onProgress?.(`Skipped git history: ${normalizeWhitespace(combineOutput(gitLog) || 'Unable to read git log')}`);
  }

  const prList = await runExecFile(
    'gh',
    ['pr', 'list', '--json', 'title,body,mergedAt', '--limit', '20'],
    { cwd: resolvedRepoPath, timeoutMs: EXEC_TIMEOUT_MS },
  );

  if (prList.ok && prList.stdout.trim()) {
    try {
      const parsed = JSON.parse(prList.stdout) as PullRequestSummary[];
      const summaries = parsed
        .map(formatPullRequestSummary)
        .filter((entry): entry is string => Boolean(entry));

      if (summaries.length > 0) {
        onProgress?.(`Importing ${summaries.length} pull request summaries...`);
        const prSummary = [
          'Recent pull request context and rationale:',
          ...summaries,
        ].join('\n');

        const prImport = await importText(prSummary, 'pull-requests');
        factsCreated += prImport.factsCreated;
        if (prImport.ok) {
          onProgress?.(`Imported ${prImport.factsCreated} facts from pull requests`);
        }
      }
    } catch {
      onProgress?.('Skipped PR summaries: could not parse gh output');
    }
  }

  return { factsCreated, commitsProcessed };
}

export async function seedFromText(text: string, source?: string): Promise<{ factsCreated: number }> {
  const result = await importText(text, source ?? 'manual-text');
  return { factsCreated: result.factsCreated };
}

export async function checkSeedingNeeded(): Promise<{ needed: boolean; currentFacts: number; recommendation: string }> {
  const result = await runCortex(['health', '--json'], { timeoutMs: EXEC_TIMEOUT_MS });
  const output = combineOutput(result);
  const healthJson = result.stdout.trim() || output;

  if (!result.ok || !healthJson) {
    return {
      needed: true,
      currentFacts: 0,
      recommendation: 'Cortex is unavailable. Install or configure Cortex, then seed from your codebase.',
    };
  }

  try {
    const parsed = JSON.parse(healthJson) as { facts?: number | string };
    const currentFacts = typeof parsed.facts === 'number'
      ? parsed.facts
      : typeof parsed.facts === 'string' && /^\d+$/.test(parsed.facts.trim())
        ? Number(parsed.facts.trim())
        : 0;

    if (currentFacts < 10) {
      return {
        needed: true,
        currentFacts,
        recommendation: 'Your memory is empty. Seed from your codebase to get started.',
      };
    }

    if (currentFacts < 50) {
      return {
        needed: true,
        currentFacts,
        recommendation: 'Your memory is sparse. Consider importing more context.',
      };
    }

    return {
      needed: false,
      currentFacts,
      recommendation: DEFAULT_OK_RECOMMENDATION,
    };
  } catch {
    return {
      needed: true,
      currentFacts: 0,
      recommendation: 'Cortex health data could not be parsed. Consider reseeding your memory.',
    };
  }
}
