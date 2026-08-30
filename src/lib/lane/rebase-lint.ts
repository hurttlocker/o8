import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { materializationAwareExecFile } from '@/lib/worktree/materialization-execution';

const execFileAsync = promisify(execFile);

const LINT_TIMEOUT_MS = 90_000;
const LINT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const LINT_OUTPUT_PREVIEW_CHARS = 4_000;
const LINTABLE_EXTENSIONS = new Set([
  '.astro',
  '.cjs',
  '.cts',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);
const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
];

interface ChangedLintFile {
  headPath: string;
  basePath: string | null;
}

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

interface LintSnapshot {
  results: EslintFileResult[];
  stderr: string;
}

export type LaneRebaseLintResult =
  | { ok: true; skipped?: string; detail?: string }
  | { ok: false; output: string };

class LintTimeoutError extends Error {}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LintTimeoutError('ESLint exceeded the 90 s timeout.');
  return remaining;
}

function errorOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  return stdout || stderr || error.message;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof LintTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const candidate = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  return candidate.killed === true || candidate.code === 'ETIMEDOUT' || candidate.signal === 'SIGTERM';
}

function readPackageJson(cwd: string): Record<string, unknown> | null {
  const packagePath = path.join(cwd, 'package.json');
  if (!existsSync(packagePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function lintAvailability(cwd: string): { skip: false; eslintScript: string } | { skip: true; reason: string } {
  const packageJson = readPackageJson(cwd);
  const scripts = packageJson?.scripts;
  const lintScript = scripts && typeof scripts === 'object'
    ? (scripts as Record<string, unknown>).lint
    : null;
  if (typeof lintScript !== 'string' || lintScript.trim().length === 0) {
    return { skip: true, reason: 'package.json has no lint script' };
  }

  const hasConfigFile = ESLINT_CONFIG_FILES.some((file) => existsSync(path.join(cwd, file)));
  if (!hasConfigFile && !packageJson?.eslintConfig) {
    return { skip: true, reason: 'no ESLint config was found' };
  }

  try {
    const requireFromRepo = createRequire(path.join(cwd, 'package.json'));
    const eslintPackage = requireFromRepo.resolve('eslint/package.json');
    const eslintScript = path.join(path.dirname(eslintPackage), 'bin', 'eslint.js');
    if (!existsSync(eslintScript)) {
      return { skip: true, reason: 'no local ESLint installation was found' };
    }
    return { skip: false, eslintScript };
  } catch {
    return { skip: true, reason: 'no local ESLint installation was found' };
  }
}

async function gitOutput(cwd: string, args: string[], deadline: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout: remainingTimeout(deadline),
    maxBuffer: LINT_MAX_BUFFER_BYTES,
    encoding: 'utf8',
  });
  return stdout;
}

function isLintableFile(file: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function parseChangedFiles(output: string, cwd: string): ChangedLintFile[] {
  const tokens = output.split('\0');
  const changed: ChangedLintFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const kind = status[0];
    const firstPath = tokens[index++] ?? '';
    const secondPath = kind === 'R' || kind === 'C' ? tokens[index++] ?? '' : '';
    const headPath = secondPath || firstPath;
    const basePath = kind === 'A' ? null : firstPath;
    if (kind === 'D' || !headPath || !isLintableFile(headPath)) continue;
    if (!existsSync(path.join(cwd, headPath))) continue;
    changed.push({ headPath, basePath });
  }
  return changed;
}

async function changedLintFiles(
  cwd: string,
  baseRef: string,
  deadline: number,
): Promise<{ mergeBase: string; files: ChangedLintFile[] }> {
  const mergeBase = (await gitOutput(cwd, ['merge-base', baseRef, 'HEAD'], deadline)).trim();
  if (!mergeBase) throw new Error(`Unable to resolve the lint merge base from ${baseRef}.`);
  const output = await gitOutput(
    cwd,
    ['diff', '--name-status', '-z', '--find-renames', `${mergeBase}..HEAD`],
    deadline,
  );
  return { mergeBase, files: parseChangedFiles(output, cwd) };
}

function parseEslintResults(stdout: string, stderr: string): LintSnapshot {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('ESLint JSON output was not an array.');
    return { results: parsed as EslintFileResult[], stderr };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`ESLint did not return valid JSON: ${reason}\n${stderr || stdout}`.trim());
  }
}

async function lintSnapshot(input: {
  cwd: string;
  eslintScript: string;
  files: string[];
  deadline: number;
}): Promise<LintSnapshot> {
  const args = [
    input.eslintScript,
    '--format',
    'json',
    '--max-warnings',
    '0',
    '--no-error-on-unmatched-pattern',
    ...input.files,
  ];
  try {
    const { stdout, stderr } = await materializationAwareExecFile(process.execPath, args, {
      windowsHide: true,
      cwd: input.cwd,
      timeout: remainingTimeout(input.deadline),
      maxBuffer: LINT_MAX_BUFFER_BYTES,
    });
    return parseEslintResults(stdout, stderr);
  } catch (error) {
    if (isTimeoutError(error)) throw new LintTimeoutError('ESLint exceeded the 90 s timeout.');
    const stdout = error instanceof Error && 'stdout' in error
      ? String((error as { stdout?: unknown }).stdout ?? '')
      : '';
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : errorOutput(error);
    if (stdout.trim()) return parseEslintResults(stdout, stderr);
    throw new Error(stderr || errorOutput(error));
  }
}

function relativeResultPath(cwd: string, filePath: string): string {
  const canonicalCwd = realpathSync(cwd);
  const canonicalFile = existsSync(filePath) ? realpathSync(filePath) : filePath;
  const relativePath = path.relative(canonicalCwd, canonicalFile);
  return relativePath.split(path.sep).join('/');
}

function isIgnoredFileWarning(message: EslintMessage): boolean {
  return message.severity === 1
    && message.ruleId === null
    && /file ignored|no matching configuration/i.test(message.message);
}

function relevantMessages(result: EslintFileResult): EslintMessage[] {
  return result.messages.filter((message) => !isIgnoredFileWarning(message));
}

function diagnosticRule(message: EslintMessage): string {
  if (message.ruleId) return message.ruleId;
  if (/unused eslint-disable directive/i.test(message.message)) return 'unused-disable';
  return 'eslint';
}

function formatDiagnostic(file: string, message: EslintMessage): string {
  const line = message.line ?? 1;
  return `${file}:${line}:${diagnosticRule(message)} ${message.message}`;
}

function formatFailure(lines: string[]): string {
  const output = lines.join('\n');
  return output.slice(0, LINT_OUTPUT_PREVIEW_CHARS) || 'Unknown lint error';
}

async function makeBaseCheckout(
  cwd: string,
  mergeBase: string,
  deadline: number,
): Promise<string> {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'o8-lint-base-'));
  try {
    await gitOutput(baseDir, ['clone', '--quiet', '--shared', '--no-checkout', cwd, '.'], deadline);
    await gitOutput(baseDir, ['checkout', '--quiet', '--detach', mergeBase], deadline);
    const sourceModules = path.join(cwd, 'node_modules');
    const baseModules = path.join(baseDir, 'node_modules');
    if (existsSync(sourceModules) && !existsSync(baseModules)) {
      symlinkSync(sourceModules, baseModules, 'junction');
    }
    return baseDir;
  } catch (error) {
    rmSync(baseDir, { recursive: true, force: true });
    throw error;
  }
}

function warningsByPath(cwd: string, snapshot: LintSnapshot): Map<string, EslintMessage[]> {
  const warnings = new Map<string, EslintMessage[]>();
  for (const result of snapshot.results) {
    warnings.set(
      relativeResultPath(cwd, result.filePath),
      relevantMessages(result).filter((message) => message.severity === 1),
    );
  }
  return warnings;
}

function warningSignature(message: EslintMessage): string {
  return `${message.ruleId ?? 'eslint'}\0${message.message}`;
}

function warningsAbsentFromBase(
  baseWarnings: EslintMessage[],
  headWarnings: EslintMessage[],
): EslintMessage[] {
  const remainingBaseSignatures = new Map<string, number>();
  for (const message of baseWarnings) {
    const signature = warningSignature(message);
    remainingBaseSignatures.set(signature, (remainingBaseSignatures.get(signature) ?? 0) + 1);
  }

  const added: EslintMessage[] = [];
  for (const message of headWarnings) {
    const signature = warningSignature(message);
    const remaining = remainingBaseSignatures.get(signature) ?? 0;
    if (remaining === 0) {
      added.push(message);
    } else {
      remainingBaseSignatures.set(signature, remaining - 1);
    }
  }
  return added;
}

/**
 * Lint only packet-attributed files, then compare warning identities with the
 * merge-base revision. Severity-2 findings always block; warnings block only
 * when their rule-and-message signature is absent from the base multiset.
 */
export async function runLaneRebaseLint(input: {
  cwd: string;
  baseRef: string;
  actualBranch: string;
  logPrefix: string;
  timeoutMs?: number;
}): Promise<LaneRebaseLintResult> {
  const timeoutMs = input.timeoutMs ?? LINT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const availability = lintAvailability(input.cwd);
  if (availability.skip) {
    console.warn(`[${input.logPrefix}] Skipping lint for ${input.actualBranch}: ${availability.reason}.`);
    return { ok: true, skipped: availability.reason };
  }

  try {
    const { mergeBase, files } = await changedLintFiles(input.cwd, input.baseRef, deadline);
    if (files.length === 0) {
      return { ok: true, detail: 'No changed lintable files.' };
    }

    const head = await lintSnapshot({
      cwd: input.cwd,
      eslintScript: availability.eslintScript,
      files: files.map((file) => file.headPath),
      deadline,
    });
    const errors: string[] = [];
    let warningCount = 0;
    for (const result of head.results) {
      const file = relativeResultPath(input.cwd, result.filePath);
      const messages = relevantMessages(result);
      warningCount += messages.filter((message) => message.severity === 1).length;
      errors.push(...messages
        .filter((message) => message.severity === 2)
        .map((message) => formatDiagnostic(file, message)));
    }
    if (errors.length > 0) {
      const output = formatFailure(errors);
      console.error(`[${input.logPrefix}] Lint failed for ${input.actualBranch}:\n${output}`);
      return { ok: false, output };
    }
    if (warningCount === 0) {
      console.log(`[${input.logPrefix}] Lint passed for ${input.actualBranch}`);
      return { ok: true };
    }

    const baseFiles = files.filter((file): file is ChangedLintFile & { basePath: string } => (
      file.basePath !== null
    ));
    const baseWarnings = new Map<string, EslintMessage[]>();
    if (baseFiles.length > 0) {
      const baseDir = await makeBaseCheckout(input.cwd, mergeBase, deadline);
      try {
        if (lintAvailability(baseDir).skip) {
          // The packet introduced lint itself, so the base had no configured
          // warning budget. Every head warning is new.
        } else {
          const base = await lintSnapshot({
            cwd: baseDir,
            eslintScript: availability.eslintScript,
            files: baseFiles.map((file) => file.basePath),
            deadline,
          });
          for (const [file, messages] of warningsByPath(baseDir, base)) {
            baseWarnings.set(file, messages);
          }
        }
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }

    const headWarnings = warningsByPath(input.cwd, head);
    const newWarnings: string[] = [];
    for (const file of files) {
      const current = headWarnings.get(file.headPath) ?? [];
      const baseline = file.basePath ? baseWarnings.get(file.basePath) ?? [] : [];
      newWarnings.push(...warningsAbsentFromBase(baseline, current)
        .map((message) => formatDiagnostic(file.headPath, message)));
    }
    if (newWarnings.length > 0) {
      const output = formatFailure(newWarnings);
      console.error(`[${input.logPrefix}] Lint introduced warnings for ${input.actualBranch}:\n${output}`);
      return { ok: false, output };
    }

    console.log(`[${input.logPrefix}] Lint passed for ${input.actualBranch}; existing base warnings did not increase.`);
    return { ok: true };
  } catch (error) {
    if (isTimeoutError(error)) {
      const reason = `ESLint exceeded the ${Math.ceil(timeoutMs / 1000)} s timeout`;
      console.warn(`[${input.logPrefix}] Skipping lint for ${input.actualBranch}: ${reason}.`);
      return { ok: true, skipped: reason };
    }
    const output = formatFailure([errorOutput(error)]);
    console.error(`[${input.logPrefix}] Lint verification failed for ${input.actualBranch}:\n${output}`);
    return { ok: false, output };
  }
}
