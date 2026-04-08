/**
 * Merge gate — hard enforcement layer for lane merges.
 *
 * Runs three checks before any merge can proceed:
 * 1. Security pattern hard-blocks (code injection, eval, etc.)
 * 2. Diff budget validation (actual diff vs preservation envelope)
 * 3. Self-review integrity (catches agents lying about results)
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

import { execSync } from 'node:child_process';
import type { PacketSelfReview } from '@/lib/orchestrator/types';
import type { Lane } from './types';

// ── Budget Constants (shared with dispatch.ts preservation envelope) ──

export const PRESERVATION_DELETE_BUDGET_RATIO = 0.1;
export const PRESERVATION_ADD_BUDGET_RATIO = 0.2;
export const PRESERVATION_MIN_DELETE_BUDGET = 5;

// Budget multiplier before a violation escalates from warning to hard-block.
// 1.5x = agent exceeded budget by 50% — likely scope creep or a rewrite.
// The agent was told its budget in the dispatch prompt. Exceeding 1.5x
// means it ignored instructions.
const BUDGET_BLOCK_MULTIPLIER = 1.5;

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
}

// ── Helpers ──

function getAddedLines(cwd: string, baseBranch: string): string[] {
  try {
    const diff = execSync(`git diff ${baseBranch}...HEAD --no-color`, {
      cwd,
      timeout: 15_000,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return diff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  } catch {
    return [];
  }
}

interface DiffNumstat {
  file: string;
  insertions: number;
  deletions: number;
}

function getDiffNumstat(cwd: string, baseBranch: string): DiffNumstat[] {
  try {
    const output = execSync(`git diff --numstat ${baseBranch}...HEAD`, {
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

// ── Check 1: Security Patterns ──

function checkSecurityPatterns(addedLines: string[]): MergeViolation[] {
  const violations: MergeViolation[] = [];

  for (const { pattern, label } of HARD_BLOCK_PATTERNS) {
    for (const line of addedLines) {
      if (pattern.test(line)) {
        violations.push({
          category: 'security',
          severity: 'block',
          label,
          detail: `New code matches blocked pattern: ${line.slice(1).trim().slice(0, 120)}`,
        });
        break; // One finding per pattern
      }
    }
  }

  return violations;
}

// ── Check 2: Diff Budget Validation ──

function checkDiffBudgets(cwd: string, baseBranch: string, repoPath: string): MergeViolation[] {
  const numstat = getDiffNumstat(cwd, baseBranch);
  if (numstat.length === 0) return [];

  // Lazy-load skeleton to avoid circular deps at module level
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAllCached } = require('@/lib/skeleton') as { getAllCached: (path: string) => Array<{ relativePath: string; lineCount: number }> };
  const skeleton = getAllCached(repoPath);
  const violations: MergeViolation[] = [];

  for (const { file, insertions, deletions } of numstat) {
    const skelFile = skeleton.find((s) => s.relativePath === file);
    if (!skelFile || skelFile.lineCount === 0) continue; // New file — no budget applies

    const addBudget = Math.ceil(skelFile.lineCount * PRESERVATION_ADD_BUDGET_RATIO);
    const deleteBudget = Math.max(
      PRESERVATION_MIN_DELETE_BUDGET,
      Math.ceil(skelFile.lineCount * PRESERVATION_DELETE_BUDGET_RATIO),
    );

    if (deletions > deleteBudget) {
      violations.push({
        category: 'budget',
        severity: deletions > deleteBudget * BUDGET_BLOCK_MULTIPLIER ? 'block' : 'warn',
        label: 'Delete budget exceeded',
        detail: `${file}: deleted ${deletions} lines (budget: ${deleteBudget}, original: ${skelFile.lineCount} lines)`,
        file,
      });
    }

    if (insertions > addBudget) {
      violations.push({
        category: 'budget',
        severity: insertions > addBudget * BUDGET_BLOCK_MULTIPLIER ? 'block' : 'warn',
        label: 'Add budget exceeded',
        detail: `${file}: added ${insertions} lines (budget: ${addBudget}, original: ${skelFile.lineCount} lines)`,
        file,
      });
    }
  }

  return violations;
}

// ── Check 3: Self-Review Integrity ──

function checkSelfReviewIntegrity(
  selfReview: PacketSelfReview | undefined,
  securityViolations: MergeViolation[],
  budgetViolations: MergeViolation[],
): MergeViolation[] {
  if (!selfReview) return [];

  const blockCount = [...securityViolations, ...budgetViolations]
    .filter((v) => v.severity === 'block').length;

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
 */
export function runMergeGate(lane: Lane, selfReview?: PacketSelfReview): MergeGateResult {
  const cwd = lane.worktreePath || lane.repoPath;
  const baseBranch = lane.baseBranch || 'main';

  const addedLines = getAddedLines(cwd, baseBranch);
  const securityViolations = checkSecurityPatterns(addedLines);
  const budgetViolations = checkDiffBudgets(cwd, baseBranch, lane.repoPath);
  const integrityViolations = checkSelfReviewIntegrity(selfReview, securityViolations, budgetViolations);

  const violations = [...securityViolations, ...budgetViolations, ...integrityViolations];
  const hasBlocks = violations.some((v) => v.severity === 'block');

  if (violations.length > 0) {
    const blockCount = violations.filter((v) => v.severity === 'block').length;
    const warnCount = violations.filter((v) => v.severity === 'warn').length;
    console.log(`[merge-gate] Lane ${lane.id}: ${blockCount} block, ${warnCount} warn`);
  }

  return { passed: !hasBlocks, violations };
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
  if (result.violations.length === 0) {
    return '## Merge gate\n\nAll checks passed. No violations detected.';
  }

  const blocks = result.violations.filter((v) => v.severity === 'block');
  const warns = result.violations.filter((v) => v.severity === 'warn');

  const lines = [
    '## Merge gate (enforcement)',
    '',
    `${blocks.length} blocking violation(s), ${warns.length} warning(s).`,
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
