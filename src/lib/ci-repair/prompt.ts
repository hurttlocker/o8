/**
 * Prompt for a session that fixes failing pull request checks (#3461).
 *
 * The session is bound to the head commit it was started for, so the UI can
 * warn when the pull request moved on before the session starts. Evidence is
 * trimmed to a fixed budget, and the instructions and the check list are
 * built first so trimming only ever shortens log excerpts.
 */

export const CI_REPAIR_MAX_PROMPT_CHARS = 12_000;
const MAX_CHECK_LIST_CHARS = 3_000;
const MAX_CHECK_LABEL_CHARS = 160;
const MIN_EXCERPT_CHARS = 400;
const EVIDENCE_HEADER = 'CI evidence:';
const TRUNCATED = '[CI evidence truncated]';

export interface CiRepairCheck {
  name: string;
  workflow?: string | null;
  url?: string | null;
  conclusion?: string | null;
  /** Check-run annotations, already formatted as `path:line message`. */
  annotations?: string[];
  /** Raw job log text; only the failing region is kept. */
  log?: string | null;
}

export interface CiRepairInput {
  repo: string;
  prNumber: number;
  headSha: string;
  branch: string;
  checks: CiRepairCheck[];
}

export interface CiRepairRequest {
  title: string;
  prompt: string;
  target: {
    repo: string;
    prNumber: number;
    headSha: string;
    branch: string;
    checks: Array<{ name: string; workflow: string | null; url: string | null }>;
  };
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const LOG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const FAILURE_LINE = /\berror\b|\bfail(?:ed|ure|s)?\b|✗|×|##\[error\]|exit code [1-9]|assert/i;

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function checkLabel(check: CiRepairCheck): string {
  return clip(check.workflow ? `${check.workflow} / ${check.name}` : check.name, MAX_CHECK_LABEL_CHARS);
}

/**
 * The part of a job log worth reading: the window ending at the last failure
 * line, with timestamps and color codes removed. Falls back to the log tail.
 */
export function failureExcerpt(log: string, maxChars: number): string {
  const lines = log
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.replace(LOG_TIMESTAMP, '').trimEnd())
    .filter((line) => line.trim() && !line.startsWith('##[group]') && !line.startsWith('##[endgroup]'));
  if (lines.length === 0 || maxChars <= 0) return '';

  let end = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (FAILURE_LINE.test(lines[index])) {
      end = Math.min(lines.length, index + 4);
      break;
    }
  }

  const kept: string[] = [];
  let used = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1;
    if (used + cost > maxChars) break;
    kept.unshift(lines[index]);
    used += cost;
  }
  return kept.join('\n');
}

export function buildCiRepairRequest(input: CiRepairInput, maxChars = CI_REPAIR_MAX_PROMPT_CHARS): CiRepairRequest {
  const { repo, prNumber, headSha, branch } = input;
  const failed = input.checks.filter((check) => check.name.trim());
  const count = failed.length;
  const title = `Fix ${count} failed CI ${count === 1 ? 'check' : 'checks'} for ${repo} PR #${prNumber}`;

  const listed: string[] = [];
  let listChars = 0;
  for (const check of failed) {
    const line = `- ${checkLabel(check)}${check.url ? ` (${check.url})` : ''}`;
    if (listChars + line.length + 1 > MAX_CHECK_LIST_CHARS) break;
    listed.push(line);
    listChars += line.length + 1;
  }
  if (listed.length < count) listed.push(`- and ${count - listed.length} more`);

  const instructions = [
    `${title}.`,
    '',
    `Work on branch \`${branch}\` at commit ${headSha.slice(0, 12)}. If the branch has moved past that commit, stop and say so.`,
    'Reproduce each failure locally with the same command CI runs, fix the cause, and rerun that command until it passes.',
    'Do not change the workflow, skip tests, or loosen assertions to make a check pass. Push the fix to the same branch.',
    '',
    'Failed checks:',
    ...listed,
  ].join('\n');

  const prefix = `${instructions}\n\n${EVIDENCE_HEADER}\n`;
  const budget = maxChars - prefix.length - TRUNCATED.length - 2;
  const blocks: string[] = [];
  let remaining = Math.max(0, budget);
  let truncated = false;

  failed.forEach((check, index) => {
    const share = Math.floor(remaining / (count - index));
    const header = `### ${checkLabel(check)}${check.conclusion ? ` (${check.conclusion})` : ''}`;
    const annotations = (check.annotations ?? []).map((annotation) => `- ${clip(annotation, 300)}`).join('\n');
    const room = share - header.length - annotations.length - 4;
    const excerpt = check.log && room >= MIN_EXCERPT_CHARS ? failureExcerpt(check.log, room) : '';
    if (check.log && !excerpt) truncated = true;
    let block = [header, annotations, excerpt ? `\`\`\`\n${excerpt}\n\`\`\`` : ''].filter(Boolean).join('\n');
    if (block.length > share) {
      block = clip(block, share);
      truncated = true;
    }
    if (block.length > 0) blocks.push(block);
    remaining -= block.length + 2;
  });

  const evidence = blocks.join('\n\n');
  const prompt = `${prefix}${evidence}${truncated ? `\n\n${TRUNCATED}` : ''}`;

  return {
    title,
    prompt: prompt.length <= maxChars ? prompt : `${prefix}${TRUNCATED}`,
    target: {
      repo,
      prNumber,
      headSha,
      branch,
      checks: failed.map((check) => ({ name: check.name, workflow: check.workflow ?? null, url: check.url ?? null })),
    },
  };
}

/** True when the pull request's head moved after the evidence was gathered. */
export function ciRepairIsStale(target: CiRepairRequest['target'], currentHeadSha: string | null | undefined): boolean {
  return Boolean(currentHeadSha) && currentHeadSha !== target.headSha;
}
