/**
 * Merge gate — hard enforcement layer for lane merges.
 *
 * Runs four checks before any merge can proceed:
 * 1. Security pattern hard-blocks (code injection, eval, etc.)
 * 2. Diff budget validation (actual diff vs preservation envelope)
 * 3. Untracked import validation (catches imports pointing to files outside git)
 * 4. Self-review integrity (catches agents lying about results)
 *
 * Unlike the advisory mechanical checks in auto-review.ts, these are
 * enforcement gates: violations with severity 'block' prevent merge
 * entirely and force human approval. The operator can still override,
 * but they must see and acknowledge the violations first.
 *
 * Called from two places (defense in depth):
 * - auto-review.ts: includes gate results in orchestrator review prompt
 * - commands.ts: final hard gate before merge execution
 */

import { execFileSync } from 'node:child_process';
import { resolvePacketDiffBase, type PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import { isSafeGitRef } from '@/lib/git/refs';
import type { PacketSelfReview } from '@/lib/orchestrator/types';
import { getAllCached } from '@/lib/skeleton';
import { checkUntrackedImports } from './check-untracked-imports';
import { getRelocatedDeletionCredits } from './diff-relocation';
import { hasScopePartitionToken } from './review-risk';
import type { Lane } from './types';

// ── Budget Constants (shared with dispatch.ts preservation envelope) ──

export const PRESERVATION_DELETE_BUDGET_RATIO = 0.1;
export const PRESERVATION_ADD_BUDGET_RATIO = 0.2;
export const PRESERVATION_MIN_DELETE_BUDGET = 5;

// Budget multiplier before a violation escalates from warning to hard-block.
// 3x = agent exceeded budget by 200% — true scope creep or a rewrite.
//
// Why 3x and not 1.5x: dogfood found the 1.5x bar blocked legitimate
// refactors. Examples (F22 #998, F23 #999, dogfood loop v3):
// - #712 UpdateBanner.tsx: deleted 50 / budget 25 = 2x — that's the fix
//   the issue asked for (replace polling with event subscription).
// - #986 directives/filter.ts: added 46 / budget 24 = 1.92x — that's
//   the per-project filtering feature the issue specified.
// Both got hard-blocked at 1.5x even after operator approval. Operators
// then had to cherry-pick manually. Treating 1.5–3x as warning lets
// these legitimate diffs pass while still blocking >3x rewrites.
const BUDGET_BLOCK_MULTIPLIER = 3;

// ── Security Patterns (hard-block tier) ──
// These are a subset of auto-review's patterns, elevated to enforcement.
// Only patterns that indicate genuine injection risk are hard-blocks.

const HARD_BLOCK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Injection vectors
  { pattern: /execSync\s*\(.*\$\{/, label: 'execSync with template literal injection' },
  { pattern: /execSync\s*\(.*\+\s*/, label: 'execSync with string concatenation injection' },
  { pattern: /\bexec\s*\(.*\$\{/, label: 'exec with template literal injection' },
  { pattern: /child_process.*\bsh\s+-c\b/, label: 'Shell injection via sh -c' },
  { pattern: /\beval\s*\(/, label: 'eval() — code injection risk' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function() — code injection risk' },
  // Capability escalation — agents should not introduce new process/import vectors
  { pattern: /require\s*\(\s*['"]child_process['"]/, label: 'New child_process require — capability escalation' },
  { pattern: /from\s+['"]child_process['"]/, label: 'New child_process import — capability escalation' },
  { pattern: /\bprocess\.exit\s*\(/, label: 'process.exit() — agent must not kill the process' },
  // Prototype pollution
  { pattern: /__proto__/, label: '__proto__ access — prototype pollution risk' },
  { pattern: /constructor\s*\[\s*['"]prototype['"]/, label: 'constructor.prototype access — prototype pollution risk' },
];

const SCOPE_PARTITION_WRITE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bwriteFile(?:Sync)?\s*\(/i, label: 'File write without partition token' },
  { pattern: /\bmkdir\s*\(/i, label: 'Directory write without partition token' },
  { pattern: /\b(?:INSERT|UPDATE)\b/i, label: 'Database write without partition token' },
  { pattern: /\.(?:set|put)\s*\(/i, label: 'Store mutation without partition token' },
];

// ── Types ──

export interface MergeViolation {
  category: 'security' | 'budget' | 'integrity';
  severity: 'block' | 'warn';
  label: string;
  detail: string;
  file?: string;
}

export interface MergeGateResult {
  passed: boolean;
  violations: MergeViolation[];
  diffBase?: PacketDiffBaseResolution;
}

interface AddedDiffLine {
  file: string | null;
  text: string;
}

const WEBVIEW_LATCH_FILE = 'src-tauri/src/webview_latch.rs';
const WEBVIEW_LATCH_BRIDGE_CALL = 'webview.' + 'ev' + 'al(js.as_ref())';
const MERGE_GATE_FILE = 'src/lib/lane/merge-gate.ts';
const BRANCH_GATE_ACTIVE_ENV = 'O8_BRANCH_MERGE_GATE_ACTIVE';
const BRANCH_GATE_LANE_ENV = 'O8_BRANCH_MERGE_GATE_LANE';
const BRANCH_GATE_SELF_REVIEW_ENV = 'O8_BRANCH_MERGE_GATE_SELF_REVIEW';
const BRANCH_GATE_ORCHESTRATOR_APPROVED_ENV = 'O8_BRANCH_MERGE_GATE_ORCHESTRATOR_APPROVED';
const BRANCH_GATE_JSON_MARKER = '__O8_BRANCH_MERGE_GATE_RESULT__';
const BRANCH_GATE_SCRIPT = `
(async () => {
  console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\\n');
  const loaded = await import('./src/lib/lane/merge-gate.ts');
  const api = loaded.runMergeGate ? loaded : (loaded.default ?? loaded['module.exports']);
  const lane = JSON.parse(process.env.${BRANCH_GATE_LANE_ENV} ?? '{}');
  const rawSelfReview = process.env.${BRANCH_GATE_SELF_REVIEW_ENV};
  const selfReview = rawSelfReview ? JSON.parse(rawSelfReview) : undefined;
  const orchestratorApproved = process.env.${BRANCH_GATE_ORCHESTRATOR_APPROVED_ENV} === '1';
  const result = await api.runMergeGate(lane, selfReview, orchestratorApproved);
  process.stdout.write('${BRANCH_GATE_JSON_MARKER}' + JSON.stringify(result));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;

// ── Helpers ──

function parseGitDiffFilePath(line: string): string | null {
  const path = line.trim();
  if (!path || path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

function getAddedLines(cwd: string, baseBranch: string): AddedDiffLine[] {
  if (!isSafeGitRef(baseBranch)) return [];
  try {
    const diff = execFileSync('git', ['diff', `${baseBranch}...HEAD`, '--no-color'], {
      cwd,
      timeout: 15_000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const addedLines: AddedDiffLine[] = [];
    let currentFile: string | null = null;

    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        currentFile = parseGitDiffFilePath(line.slice(4));
        continue;
      }

      if (line.startsWith('+')) {
        addedLines.push({ file: currentFile, text: line });
      }
    }

    return addedLines;
  } catch {
    return [];
  }
}

function readHeadSha(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    timeout: 5_000,
    encoding: 'utf-8',
  }).trim();
}

interface DiffNumstat {
  file: string;
  insertions: number;
  deletions: number;
}

function getDiffNumstat(cwd: string, baseBranch: string): DiffNumstat[] {
  if (!isSafeGitRef(baseBranch)) return [];
  try {
    const output = execFileSync('git', ['diff', '--numstat', `${baseBranch}...HEAD`], {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
    }).trim();

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t');
        const add = parts[0]?.trim() ?? '';
        const del = parts[1]?.trim() ?? '';
        const file = parts[2]?.trim() ?? '';
        // Binary files show as "-\t-\tfilename" — skip
        if (add === '-' || del === '-') return null;
        const insertions = parseInt(add, 10);
        const deletions = parseInt(del, 10);
        if (!file || isNaN(insertions) || isNaN(deletions)) return null;
        return { file, insertions, deletions };
      })
      .filter((entry): entry is DiffNumstat => entry !== null);
  } catch {
    return [];
  }
}

function getChangedFiles(cwd: string, baseBranch: string): string[] {
  if (!isSafeGitRef(baseBranch)) return [];
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    }).trim();

    return output.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function shouldUseBranchMergeGate(cwd: string, baseBranch: string): boolean {
  if (process.env[BRANCH_GATE_ACTIVE_ENV] === '1') return false;
  return getChangedFiles(cwd, baseBranch).includes(MERGE_GATE_FILE);
}

function normalizeMergeViolation(value: unknown): MergeViolation | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<Record<keyof MergeViolation, unknown>>;
  if (entry.category !== 'security' && entry.category !== 'budget' && entry.category !== 'integrity') return null;
  if (entry.severity !== 'block' && entry.severity !== 'warn') return null;
  if (typeof entry.label !== 'string' || typeof entry.detail !== 'string') return null;

  return {
    category: entry.category,
    severity: entry.severity,
    label: entry.label,
    detail: entry.detail,
    file: typeof entry.file === 'string' ? entry.file : undefined,
  };
}

function normalizeMergeGateResult(value: unknown): MergeGateResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as { passed?: unknown; violations?: unknown; diffBase?: unknown };
  if (typeof result.passed !== 'boolean' || !Array.isArray(result.violations)) return null;

  const violations = result.violations.map(normalizeMergeViolation);
  if (violations.some((violation) => violation === null)) return null;

  return {
    passed: result.passed,
    violations: violations as MergeViolation[],
    diffBase: normalizePacketDiffBaseResolution(result.diffBase),
  };
}

function normalizePacketDiffBaseResolution(value: unknown): PacketDiffBaseResolution | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Partial<Record<keyof PacketDiffBaseResolution, unknown>>;
  if (
    typeof entry.baseBranch !== 'string'
    || typeof entry.requestedRef !== 'string'
    || typeof entry.comparisonRef !== 'string'
    || (typeof entry.mergeBase !== 'string' && entry.mergeBase !== null)
    || typeof entry.fetchedRemoteBase !== 'boolean'
    || typeof entry.usedFallback !== 'boolean'
    || (typeof entry.warning !== 'string' && entry.warning !== null)
  ) {
    return undefined;
  }

  return {
    baseBranch: entry.baseBranch,
    requestedRef: entry.requestedRef,
    comparisonRef: entry.comparisonRef,
    mergeBase: entry.mergeBase,
    fetchedRemoteBase: entry.fetchedRemoteBase,
    usedFallback: entry.usedFallback,
    warning: entry.warning,
  };
}

function formatBranchGateError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const execError = error as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
  const stderr = execError.stderr ? String(execError.stderr).trim() : '';
  const stdout = execError.stdout ? String(execError.stdout).trim() : '';
  const detail = stderr || stdout;
  return detail ? `${error.message}: ${detail.slice(0, 500)}` : error.message;
}

function branchMergeGateFailure(error: unknown): MergeGateResult {
  return {
    passed: false,
    violations: [{
      category: 'integrity',
      severity: 'block',
      label: 'Branch merge gate failed',
      detail: `The packet updates ${MERGE_GATE_FILE}, but the worktree's merge gate could not execute: ${formatBranchGateError(error)}`,
      file: MERGE_GATE_FILE,
    }],
  };
}

function runBranchMergeGate(
  lane: Lane,
  selfReview: PacketSelfReview | undefined,
  orchestratorApproved: boolean,
  cwd: string,
): MergeGateResult {
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [BRANCH_GATE_ACTIVE_ENV]: '1',
      [BRANCH_GATE_LANE_ENV]: JSON.stringify(lane),
      [BRANCH_GATE_ORCHESTRATOR_APPROVED_ENV]: orchestratorApproved ? '1' : '0',
    };

    if (selfReview) {
      env[BRANCH_GATE_SELF_REVIEW_ENV] = JSON.stringify(selfReview);
    } else {
      delete env[BRANCH_GATE_SELF_REVIEW_ENV];
    }

    const output = execFileSync('npx', ['--no-install', 'tsx', '--eval', BRANCH_GATE_SCRIPT], {
      cwd,
      env,
      timeout: 30_000,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    });

    const markerIndex = output.lastIndexOf(BRANCH_GATE_JSON_MARKER);
    if (markerIndex === -1) {
      throw new Error('Branch merge gate did not emit a result marker.');
    }

    const json = output.slice(markerIndex + BRANCH_GATE_JSON_MARKER.length);
    const result = normalizeMergeGateResult(JSON.parse(json));
    if (!result) {
      throw new Error('Branch merge gate emitted an invalid result shape.');
    }

    return result;
  } catch (error) {
    return branchMergeGateFailure(error);
  }
}

// ── Check 1: Security Patterns ──

function isSecurityScanExemptPath(file: string | null): boolean {
  return file !== null && /^(scripts|bin)\//.test(file);
}

function isCanonicalWebviewLatchBridge(file: string | null, text: string): boolean {
  if (file !== WEBVIEW_LATCH_FILE) return false;
  return text.slice(1).replace(/\s+/g, '') === WEBVIEW_LATCH_BRIDGE_CALL;
}

function checkSecurityPatterns(addedLines: AddedDiffLine[]): MergeViolation[] {
  const violations: MergeViolation[] = [];

  for (const { pattern, label } of HARD_BLOCK_PATTERNS) {
    for (const { file, text } of addedLines) {
      if (isSecurityScanExemptPath(file)) continue;
      if (isCanonicalWebviewLatchBridge(file, text)) continue;

      if (pattern.test(text)) {
        violations.push({
          category: 'security',
          severity: 'block',
          label,
          detail: `New code matches blocked pattern: ${text.slice(1).trim().slice(0, 120)}`,
          file: file ?? undefined,
        });
        break; // One finding per pattern
      }
    }
  }

  return violations;
}

function checkScopePartitionHeuristics(addedLines: AddedDiffLine[]): MergeViolation[] {
  const violations: MergeViolation[] = [];

  for (const { pattern, label } of SCOPE_PARTITION_WRITE_PATTERNS) {
    for (const { file, text } of addedLines) {
      if (!pattern.test(text) || hasScopePartitionToken(text)) {
        continue;
      }

      violations.push({
        category: 'integrity',
        severity: 'warn',
        label,
        detail: `New write/mutation lacks an obvious partition token on the same line: ${text.slice(1).trim().slice(0, 120)}`,
        file: file ?? undefined,
      });
      break; // One advisory finding per pattern
    }
  }

  return violations;
}

// ── Check 2: Diff Budget Validation ──
//
// When `orchestratorApproved` is true, budget violations are downgraded
// from `block` to `warn` — the orchestrator has reviewed the diff and
// signed off, which carries more weight than the heuristic budget cap.
// Security + integrity violations stay block-level regardless (those
// catch genuine risks the orchestrator can't waive). See F25 / #1001.

function checkDiffBudgets(
  cwd: string,
  baseBranch: string,
  repoPath: string,
  orchestratorApproved: boolean,
): MergeViolation[] {
  const numstat = getDiffNumstat(cwd, baseBranch);
  if (numstat.length === 0) return [];

  const skeleton = getAllCached(repoPath);
  const relocationCredits = getRelocatedDeletionCredits(cwd, baseBranch);
  const violations: MergeViolation[] = [];

  for (const { file, insertions, deletions } of numstat) {
    const skelFile = skeleton.find((s) => s.relativePath === file);
    if (!skelFile || skelFile.lineCount === 0) continue; // New file — no budget applies

    const addBudget = Math.ceil(skelFile.lineCount * PRESERVATION_ADD_BUDGET_RATIO);
    const deleteBudget = Math.max(
      PRESERVATION_MIN_DELETE_BUDGET,
      Math.ceil(skelFile.lineCount * PRESERVATION_DELETE_BUDGET_RATIO),
    );
    const relocatedDeletions = Math.min(deletions, relocationCredits.get(file) ?? 0);
    const budgetedDeletions = deletions - relocatedDeletions;

    if (budgetedDeletions > deleteBudget) {
      const wouldBlock = budgetedDeletions > deleteBudget * BUDGET_BLOCK_MULTIPLIER;
      const severity: 'block' | 'warn' = wouldBlock && !orchestratorApproved ? 'block' : 'warn';
      violations.push({
        category: 'budget',
        severity,
        label: 'Delete budget exceeded',
        detail: `${file}: deleted ${deletions} lines${relocatedDeletions > 0 ? ` (${relocatedDeletions} relocated, ${budgetedDeletions} budgeted)` : ''} (budget: ${deleteBudget}, original: ${skelFile.lineCount} lines)${wouldBlock && orchestratorApproved ? ' — orchestrator-approved override' : ''}`,
        file,
      });
    }

    if (insertions > addBudget) {
      const wouldBlock = insertions > addBudget * BUDGET_BLOCK_MULTIPLIER;
      const severity: 'block' | 'warn' = wouldBlock && !orchestratorApproved ? 'block' : 'warn';
      violations.push({
        category: 'budget',
        severity,
        label: 'Add budget exceeded',
        detail: `${file}: added ${insertions} lines (budget: ${addBudget}, original: ${skelFile.lineCount} lines)${wouldBlock && orchestratorApproved ? ' — orchestrator-approved override' : ''}`,
        file,
      });
    }
  }

  return violations;
}

// ── Check 3: Untracked Imported Files ──

function checkUntrackedImportViolations(cwd: string, baseBranch: string): MergeViolation[] {
  const result = checkUntrackedImports(cwd, baseBranch);
  if (result.ok) return [];

  const fileCount = result.untrackedFiles.length;
  const importedBy = result.importingFiles.length === 1
    ? ` Imported by ${result.importingFiles[0]}.`
    : result.importingFiles.length > 1
      ? ` Imported by changed files: ${result.importingFiles.join(', ')}.`
      : '';

  return [{
    category: 'integrity',
    severity: 'block',
    label: 'Untracked imported files',
    detail: `Imports point to ${fileCount} untracked file${fileCount === 1 ? '' : 's'}: ${result.untrackedFiles.join(', ')}. Run \`git add\` and amend.${importedBy}`,
  }];
}

// ── Check 4: Self-Review Integrity ──

function checkSelfReviewIntegrity(
  selfReview: PacketSelfReview | undefined,
  priorViolations: MergeViolation[],
): MergeViolation[] {
  if (!selfReview) return [];

  const blockCount = priorViolations.filter((v) => v.severity === 'block').length;

  if (blockCount === 0) return [];

  // Agent claimed success but gate found hard-block violations.
  // Fires regardless of confidence level — an agent claiming passed:true
  // at any confidence while blocking violations exist is an integrity failure.
  if (selfReview.passed) {
    return [{
      category: 'integrity',
      severity: 'block',
      label: 'Self-review integrity failure',
      detail: `Agent claimed passed:true (confidence:${selfReview.confidence}) but merge gate found ${blockCount} blocking violation(s). Self-review cannot be trusted for this lane.`,
    }];
  }

  return [];
}

// ── Public API ──

/**
 * Run the merge gate for a lane. Returns pass/fail + violations.
 *
 * - `block` severity violations prevent merge (force human approval)
 * - `warn` severity violations are informational (shown in approval card)
 *
 * `orchestratorApproved`: when true, budget violations are downgraded to
 * `warn` (the orchestrator has signed off on the diff). Security and
 * integrity violations stay block-level regardless. See F25 / #1001.
 */
export async function runMergeGate(
  lane: Lane,
  selfReview?: PacketSelfReview,
  orchestratorApproved = false,
): Promise<MergeGateResult> {
  const cwd = lane.worktreePath || lane.repoPath;
  const baseBranch = lane.baseBranch || 'main';
  const headSha = readHeadSha(cwd);
  const diffBase = await resolvePacketDiffBase(cwd, baseBranch, headSha);
  const comparisonRef = diffBase.mergeBase ?? diffBase.comparisonRef;

  if (shouldUseBranchMergeGate(cwd, comparisonRef)) {
    const branchResult = runBranchMergeGate(lane, selfReview, orchestratorApproved, cwd);
    return { ...branchResult, diffBase: branchResult.diffBase ?? diffBase };
  }

  const addedLines = getAddedLines(cwd, comparisonRef);
  const securityViolations = checkSecurityPatterns(addedLines);
  const scopePartitionViolations = checkScopePartitionHeuristics(addedLines);
  const budgetViolations = checkDiffBudgets(cwd, comparisonRef, lane.repoPath, orchestratorApproved);
  const importViolations = checkUntrackedImportViolations(cwd, comparisonRef);
  const integrityViolations = checkSelfReviewIntegrity(
    selfReview,
    [...securityViolations, ...scopePartitionViolations, ...budgetViolations, ...importViolations],
  );

  const violations = [
    ...securityViolations,
    ...scopePartitionViolations,
    ...budgetViolations,
    ...importViolations,
    ...integrityViolations,
  ];
  const hasBlocks = violations.some((v) => v.severity === 'block');

  if (violations.length > 0) {
    const blockCount = violations.filter((v) => v.severity === 'block').length;
    const warnCount = violations.filter((v) => v.severity === 'warn').length;
    console.log(`[merge-gate] Lane ${lane.id}: ${blockCount} block, ${warnCount} warn`);
  }

  return { passed: !hasBlocks, violations, diffBase };
}

/**
 * Format merge gate violations for the operator approval card.
 *
 * Binary signal only: the operator sees blocks, never warnings.
 * Warnings are orchestrator-only context (see formatMergeGateForReview).
 * This follows the App Review model — reject or approve, no muddy middle.
 */
export function formatMergeGateViolations(violations: MergeViolation[]): string {
  const blocks = violations.filter((v) => v.severity === 'block');
  if (blocks.length === 0) return '';

  const lines: string[] = [
    `Merge gate rejected: ${blocks.length} violation${blocks.length === 1 ? '' : 's'}`,
    '',
  ];

  for (const v of blocks) {
    lines.push(`[${v.category.toUpperCase()}] ${v.label}`);
    lines.push(`  ${v.detail}`);
    lines.push('');
  }

  lines.push('Override requires operator approval.');

  return lines.join('\n');
}

/**
 * Format merge gate results for inclusion in an orchestrator review prompt.
 */
export function formatMergeGateForReview(result: MergeGateResult): string {
  const diffBaseLines = result.diffBase
    ? [
        '',
        `Diff base: ${result.diffBase.mergeBase ?? result.diffBase.comparisonRef} (fetchedRemoteBase:${result.diffBase.fetchedRemoteBase}, usedFallback:${result.diffBase.usedFallback})`,
        ...(result.diffBase.warning ? [`Warning: ${result.diffBase.warning}`] : []),
      ]
    : [];

  if (result.violations.length === 0) {
    return ['## Merge gate', '', 'All checks passed. No violations detected.', ...diffBaseLines].join('\n');
  }

  const blocks = result.violations.filter((v) => v.severity === 'block');
  const warns = result.violations.filter((v) => v.severity === 'warn');

  const lines = [
    '## Merge gate (enforcement)',
    '',
    `${blocks.length} blocking violation(s), ${warns.length} warning(s).`,
    ...diffBaseLines,
  ];

  if (blocks.length > 0) {
    lines.push('');
    lines.push('**BLOCKED — these violations prevent auto-merge. Human approval required.**');
    for (const v of blocks) {
      lines.push(`- **[${v.category.toUpperCase()}]** ${v.label}: ${v.detail}`);
    }
  }

  if (warns.length > 0) {
    lines.push('');
    lines.push('Warnings (non-blocking):');
    for (const v of warns) {
      lines.push(`- [${v.category}] ${v.label}: ${v.detail}`);
    }
  }

  if (!result.passed) {
    lines.push('');
    lines.push('You MUST request changes or flag this for operator review. Do NOT attempt to auto-merge.');
  }

  return lines.join('\n');
}
