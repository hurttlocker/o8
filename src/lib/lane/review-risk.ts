export type ReviewRiskTier = 'standard' | 'high';

export interface ReviewRiskClassification {
  tier: ReviewRiskTier;
  reasons: string[];
}

const HIGH_RISK_PATH_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:^|\/)db(?:\/|$)/i, reason: 'path-glob: database code or schema state' },
  { pattern: /schema\.ts$/i, reason: 'path-glob: schema definition' },
  { pattern: /migration/i, reason: 'path-glob: migration path' },
  { pattern: /(?:^|\/)(?:session[_-]?outcomes?|ledger)(?:\/|$)/i, reason: 'path-glob: session outcome or ledger writer' },
  { pattern: /(?:^|\/)(?:directives?|directive-store)(?:\/|$)/i, reason: 'path-glob: directive storage' },
  { pattern: /^src\/lib\/lane\/(?:commands|reconcile|lifecycle|worktree-side-merge)\.ts$/i, reason: 'path-glob: live lane state machine' },
  { pattern: /^src\/lib\/orchestrator\/.*(?:state|store|control-plane).*\.ts$/i, reason: 'path-glob: orchestrator state/control-plane' },
  {
    pattern: /^src\/lib\/cortex\/(?:spec-ingest|.*(?:store|writer|storage|persist|directive|ledger)).*\.ts$/i,
    reason: 'path-glob: cortex writer',
  },
  { pattern: /(?:getDataDir|\.o8|directives)/i, reason: 'path-glob: shared data directory writer' },
];

const HIGH_RISK_LINE_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsetLaneStatus\s*\(/, reason: 'code-symbol: lane status transition site' },
];

const ADVISORY_LINE_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(?:INSERT|UPDATE)\b|\.prepare\s*\(/i, reason: 'advisory: db write or prepared statement added' },
  { pattern: /\b(?:writeFile|writeFileSync|mkdir|mkdirSync)\s*\(.*(?:getDataDir|\.o8|directives)/i, reason: 'advisory: shared directory write added' },
  { pattern: /\.(?:set|put|append)\s*\(.*(?:global|all repos|every repo|getDataDir|\.o8|directives)/i, reason: 'advisory: global store mutation added' },
  { pattern: /['"`](?:global|all repos|every repo)['"`]/i, reason: 'advisory: global scope literal added' },
];

const SCOPE_PARTITION_TOKEN_PATTERN = /\b(?:repo|tenant|user|project|lane|packet|scope|slug|id)\b/i;

export function hasScopePartitionToken(line: string): boolean {
  return SCOPE_PARTITION_TOKEN_PATTERN.test(line);
}

function addUnique(reasons: string[], seen: Set<string>, reason: string): void {
  if (seen.has(reason)) return;
  seen.add(reason);
  reasons.push(reason);
}

function normalizeAddedLine(line: string): string {
  return line.startsWith('+') ? line.slice(1).trim() : line.trim();
}

export function classifyReviewRisk(
  changedFiles: string[],
  addedLines: string[],
): ReviewRiskClassification {
  const reasons: string[] = [];
  const seen = new Set<string>();

  for (const file of changedFiles) {
    const normalized = file.trim();
    if (!normalized) continue;
    for (const rule of HIGH_RISK_PATH_RULES) {
      if (rule.pattern.test(normalized)) {
        addUnique(reasons, seen, `${rule.reason}: ${normalized}`);
        break;
      }
    }
  }

  for (const rawLine of addedLines) {
    const line = normalizeAddedLine(rawLine);
    for (const rule of HIGH_RISK_LINE_RULES) {
      if (rule.pattern.test(line)) {
        addUnique(reasons, seen, rule.reason);
      }
    }
  }

  const tier: ReviewRiskTier = reasons.length > 0 ? 'high' : 'standard';
  if (tier === 'high') {
    for (const rawLine of addedLines) {
      const line = normalizeAddedLine(rawLine);
      for (const rule of ADVISORY_LINE_RULES) {
        if (rule.pattern.test(line)) {
          addUnique(reasons, seen, rule.reason);
        }
      }
      if (
        /\b(?:writeFile|writeFileSync|mkdir|mkdirSync)\s*\(/i.test(line)
        && !hasScopePartitionToken(line)
      ) {
        addUnique(reasons, seen, 'advisory: write added without an obvious partition key');
      }
    }
  }

  return { tier, reasons };
}

export function buildAdversarialReviewProtocol(tier: ReviewRiskTier): string {
  if (tier !== 'high') return '';

  return [
    '## HIGH-RISK REVIEW',
    '',
    'This diff touches live state / data writes.',
    'After your first verdict, do a SECOND skeptical pass in THIS SAME turn that ASSUMES the change is wrong and specifically tries to prove a scope/partition leak or an inert guard.',
    'KEEP an approve verdict only if the second pass also clears it, citing the file:line that proves correctness.',
    'Do NOT default to reject.',
  ].join('\n');
}

// codex-928's shape is a write into the single global ~/.o8/directives dir
// where the per-repo partition lives in the filename/id (directiveFilenameFor),
// not the directory. The path glob flags it; the prompt's partition trace is
// the substantive catch.
