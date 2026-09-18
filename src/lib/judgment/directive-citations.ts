/**
 * Rule citations on the merge preview (#2446, program #2481). ADVISORY.
 *
 * When `judgment.provider` is on, each changed file is judged against the
 * repo's ingested rules that match its path, one yes/no question per rule in
 * one call per file. A rule is one of six locked "Critical Rules / NEVER"
 * sentences, found as a line of an ingested spec directive; the rule text is
 * that line exactly as stored, with the directive id it came from. A file is
 * asked about at most five rules, chosen by the path recipe below.
 *
 * The state is o8-computed facts only: the rule ids and quoted texts, the file
 * path, its added and removed counts, and its hunk. No packet title, summary,
 * or worker report. Every call writes a receipt carrying the selection.
 *
 * The calls run detached, like the approval referee: the first preview for a
 * diff answers `pending` and starts them; once they settle, a
 * `directive_citations` lane event holds every score and the next preview for
 * the same diff answers `ready`. The CSS-shorthand rule is asked and recorded
 * but never cited (held back until the replay scores it). Nothing in the
 * merge gate reads any of this.
 */
import { basename } from 'node:path';

import { approvalDiffFingerprint } from '@/lib/approvals/referee';
import { specIngestSlugFromId } from '@/lib/cortex/spec-ingest';
import { getSqlite } from '@/lib/db';
import type { Lane } from '@/lib/lane/types';
import { askJudgment, type AskJudgmentOptions } from './client';
import { buildDiffState } from './diff-state';
import type { DirectiveCitation, DirectiveCitationsPreview } from './directive-citations-format';
import { DIRECTIVE_CITATION_QUESTION, DIRECTIVE_CITATION_THRESHOLD } from './questions';
import { isJudgmentRefereeEnabled } from './route';
import type { NoulQuestion } from './types';

export const DIRECTIVE_CITATIONS_SURFACE = 'directive-citations';
/** Name of the path recipe; recorded on every receipt and on the lane event. */
export const DIRECTIVE_CITATION_RECIPE = 'critical-rules-never-v1';
export const MAX_DIRECTIVES_PER_FILE = 5;
/** Hunk budget per call. */
const HUNK_BUDGET_TOKENS = 8_000;

export type LockedRuleKey = 'css-classes' | 'rgba-surfaces' | 'css-shorthand' | 'throw-in-api-routes' | 'hardcoded-ports' | 'users-paths';

interface LockedRule {
  key: LockedRuleKey;
  /** The rule's opening sentence in CLAUDE.md "Critical Rules / NEVER". */
  sentence: string;
  appliesTo: (path: string) => boolean;
  /** Test files are exempt: every real positive in the lab for these rules was a test fixture. */
  testExempt: boolean;
  /** Asked and recorded, never cited. */
  heldBack: boolean;
}

const TS_FILE = /\.tsx?$/;
const COMPONENT_TSX = /^src\/components\/.+\.tsx$/;
const SRC_TSX = /^src\/.+\.tsx$/;
const API_ROUTE = /^src\/app\/api\/(?:.+\/)?route\.ts$/;
const PORT_CONSTANTS = 'src/lib/panel/port-constants.ts';

export const isTestFile = (path: string) => /\.test\.tsx?$/.test(path) || path.startsWith('tests/');

/** The six locked rules and the path recipe (lab 2026-09-18: removes no positive, cuts negatives 64-89%). */
export const LOCKED_RULES: readonly LockedRule[] = [
  { key: 'css-classes', sentence: 'Never use CSS classes', appliesTo: (path) => COMPONENT_TSX.test(path), testExempt: false, heldBack: false },
  { key: 'rgba-surfaces', sentence: 'Never hardcode rgba colors for surfaces', appliesTo: (path) => SRC_TSX.test(path), testExempt: false, heldBack: false },
  { key: 'css-shorthand', sentence: 'Never use CSS shorthand', appliesTo: (path) => SRC_TSX.test(path), testExempt: false, heldBack: true },
  { key: 'throw-in-api-routes', sentence: 'Never throw in API routes', appliesTo: (path) => API_ROUTE.test(path), testExempt: false, heldBack: false },
  { key: 'hardcoded-ports', sentence: 'Never hardcode API/WS ports', appliesTo: (path) => TS_FILE.test(path) && path !== PORT_CONSTANTS, testExempt: true, heldBack: false },
  { key: 'users-paths', sentence: 'Never hardcode `/Users/example/*` paths', appliesTo: (path) => TS_FILE.test(path), testExempt: true, heldBack: false },
];

/** One locked rule as found in the repo's ingested directives. */
export interface DirectiveRule {
  ruleId: string;
  directiveId: string;
  key: LockedRuleKey;
  text: string;
  heldBack: boolean;
}

export interface DirectiveCitationScore {
  ruleId: string;
  directiveId: string;
  path: string;
  probability: number;
  receiptId: string | null;
  heldBack?: true;
}

/** Payload of the `directive_citations` lane event. */
export interface DirectiveCitationsRecord {
  packetId: string;
  diffFingerprint: string;
  recipe: string;
  rulesFound: string[];
  rulesMissing: LockedRuleKey[];
  files: Array<{ path: string; asked: string[]; exemptions: LockedRuleKey[]; receiptId: string | null; truncated: boolean; failed: boolean }>;
  scores: DirectiveCitationScore[];
  citations: DirectiveCitation[];
  receiptIds: string[];
}

/** A stored line opens a locked rule when, past its list marker and bold, it starts with the sentence. */
function opensRule(line: string, sentence: string): boolean {
  return line.replace(/^\s*[-*+]\s+/, '').replace(/^\*\*/, '').startsWith(sentence);
}

/**
 * The locked rules this repo's ingested spec directives contain, read from
 * the directive index spec-ingest writes. Directives are matched to the repo
 * by the slug in their id, as `directiveAppliesToRepo` matches by basename.
 */
export function readDirectiveRules(repoPath: string): { rules: DirectiveRule[]; missing: LockedRuleKey[] } {
  const slug = basename(repoPath).toLowerCase();
  let rows: Array<{ id: string; body: string }> = [];
  try {
    rows = (getSqlite().prepare(`
      SELECT directive_id AS id, body FROM directives_fts WHERE directive_id LIKE 'spec-ingest:%' ORDER BY directive_id
    `).all() as Array<{ id: string; body: string }>).filter((row) => specIngestSlugFromId(row.id) === slug);
  } catch (error) {
    console.warn('[directive-citations] directive index unreadable:', error instanceof Error ? error.message : 'error');
  }
  const rules: DirectiveRule[] = [];
  const missing: LockedRuleKey[] = [];
  for (const locked of LOCKED_RULES) {
    let found: DirectiveRule | null = null;
    for (const row of rows) {
      const line = row.body.split('\n').find((candidate) => opensRule(candidate, locked.sentence));
      if (line === undefined) continue;
      found = { ruleId: `${row.id}#${locked.key}`, directiveId: row.id, key: locked.key, text: line, heldBack: locked.heldBack };
      break;
    }
    if (found) rules.push(found);
    else missing.push(locked.key);
  }
  return { rules, missing };
}

/** The rules asked for one path, and the rules the test-file exemption removed. */
export function selectRulesForPath(path: string, rules: readonly DirectiveRule[]): { asked: DirectiveRule[]; exemptions: LockedRuleKey[] } {
  const asked: DirectiveRule[] = [];
  const exemptions: LockedRuleKey[] = [];
  for (const rule of rules) {
    const locked = LOCKED_RULES.find((entry) => entry.key === rule.key);
    if (!locked?.appliesTo(path)) continue;
    if (locked.testExempt && isTestFile(path)) { exemptions.push(rule.key); continue; }
    asked.push(rule);
  }
  if (asked.length > MAX_DIRECTIVES_PER_FILE) {
    console.warn(`[directive-citations] ${asked.length} rules matched ${path}; asking the first ${MAX_DIRECTIVES_PER_FILE}`);
  }
  return { asked: asked.slice(0, MAX_DIRECTIVES_PER_FILE), exemptions };
}

let transportOverride: AskJudgmentOptions | undefined;
const inFlight = new Map<string, Promise<DirectiveCitationsRecord | null>>();

/** Test-only: point the calls at a local endpoint fixture. */
export function setDirectiveCitationsTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/** Resolves when the run started for this lane has settled; null when none ran. */
export async function waitForDirectiveCitations(laneId: string): Promise<DirectiveCitationsRecord | null> {
  return (await inFlight.get(laneId)) ?? null;
}

interface RunInput {
  laneId: string;
  packetId: string;
  repoPath: string;
  diffText: string;
  diffFingerprint: string;
}

async function runDirectiveCitations(input: RunInput): Promise<DirectiveCitationsRecord> {
  const { parseGitDiff } = await import('@/lib/worktree/diff-parser');
  const { rules, missing } = readDirectiveRules(input.repoPath);
  const record: DirectiveCitationsRecord = {
    packetId: input.packetId,
    diffFingerprint: input.diffFingerprint,
    recipe: DIRECTIVE_CITATION_RECIPE,
    rulesFound: rules.map((rule) => rule.ruleId),
    rulesMissing: missing,
    files: [],
    scores: [],
    citations: [],
    receiptIds: [],
  };
  const files = parseGitDiff(input.diffText)
    .filter((file) => file.status !== 'D')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // One call at a time, in path order, so the same diff always asks the same way.
  for (const file of files) {
    const { asked, exemptions } = selectRulesForPath(file.path, rules);
    if (asked.length === 0) {
      if (exemptions.length > 0) record.files.push({ path: file.path, asked: [], exemptions, receiptId: null, truncated: false, failed: false });
      continue;
    }
    const built = buildDiffState([{ path: file.path }], file.patch, HUNK_BUDGET_TOKENS);
    const facts = built.state.files.find((entry) => entry.path === file.path) ?? built.state.files[0];
    const questions: Record<string, NoulQuestion> = Object.fromEntries(asked.map((rule) => [rule.ruleId, DIRECTIVE_CITATION_QUESTION]));
    const result = await askJudgment({
      state: {
        rules: Object.fromEntries(asked.map((rule) => [rule.ruleId, { id: rule.ruleId, text: rule.text }])),
        file: { path: file.path, added: facts?.additions ?? 0, removed: facts?.deletions ?? 0 },
        hunk: built.state.diff,
      },
      questions,
      context: {
        packetId: input.packetId,
        laneId: input.laneId,
        surface: DIRECTIVE_CITATIONS_SURFACE,
        truncated: built.truncated,
        hiddenText: built.hiddenText,
        selection: { recipe: DIRECTIVE_CITATION_RECIPE, path: file.path, directiveIds: asked.map((rule) => rule.ruleId), exemptions },
      },
    }, transportOverride);
    record.files.push({
      path: file.path,
      asked: asked.map((rule) => rule.ruleId),
      exemptions,
      receiptId: result?.receiptId ?? null,
      truncated: built.truncated,
      failed: !result,
    });
    if (!result) continue;
    if (result.receiptId) record.receiptIds.push(result.receiptId);
    for (const rule of asked) {
      const probability = result.answers[rule.ruleId].noul;
      record.scores.push({
        ruleId: rule.ruleId,
        directiveId: rule.directiveId,
        path: file.path,
        probability,
        receiptId: result.receiptId,
        ...(rule.heldBack ? { heldBack: true as const } : {}),
      });
      if (rule.heldBack || probability < DIRECTIVE_CITATION_THRESHOLD) continue;
      record.citations.push({ directiveId: rule.directiveId, ruleId: rule.ruleId, ruleText: rule.text, path: file.path, probability, receiptId: result.receiptId });
    }
  }
  const { recordLaneEvent } = await import('@/lib/lane/events');
  recordLaneEvent(input.laneId, 'directive_citations', 'system', { ...record });
  return record;
}

function readRecordedCitations(laneId: string, diffFingerprint: string): DirectiveCitationsRecord | null {
  const rows = getSqlite().prepare(`
    SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'directive_citations' ORDER BY rowid DESC LIMIT 20
  `).all(laneId) as Array<{ payload_json: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as DirectiveCitationsRecord;
      if (payload.diffFingerprint === diffFingerprint) return payload;
    } catch { /* skip an unreadable row */ }
  }
  return null;
}

const ready = (record: DirectiveCitationsRecord): DirectiveCitationsPreview => (
  { status: 'ready', citations: record.citations, receiptIds: record.receiptIds }
);

/**
 * The advisory field for a merge preview, or undefined when the setting is
 * off (no git, no network, no field). Never throws and never waits on the
 * provider: a diff with no recorded result starts the run and answers pending.
 */
export async function directiveCitationsForPreview(
  lane: Pick<Lane, 'id' | 'repoPath'>,
  packetId: string,
  cwd: string,
  baseRef: string,
): Promise<DirectiveCitationsPreview | undefined> {
  if (!isJudgmentRefereeEnabled()) return undefined;
  try {
    const { getDiffForLane } = await import('@/lib/lane/commands-approval');
    const { parseGitDiff } = await import('@/lib/worktree/diff-parser');
    const diffText = await getDiffForLane({ baseBranch: baseRef, worktreePath: cwd, repoPath: lane.repoPath });
    const diffFingerprint = approvalDiffFingerprint(diffText, parseGitDiff(diffText).map((file) => file.path));
    const recorded = readRecordedCitations(lane.id, diffFingerprint);
    if (recorded) return ready(recorded);
    if (!inFlight.has(lane.id)) {
      const promise = runDirectiveCitations({ laneId: lane.id, packetId, repoPath: lane.repoPath, diffText, diffFingerprint })
        .catch((error) => {
          console.warn('[directive-citations] skipped:', error instanceof Error ? error.message : 'error');
          return null;
        })
        .finally(() => {
          if (inFlight.get(lane.id) === promise) inFlight.delete(lane.id);
        });
      inFlight.set(lane.id, promise);
    }
    return { status: 'pending', citations: [], receiptIds: [] };
  } catch (error) {
    console.warn('[directive-citations] preview field skipped:', error instanceof Error ? error.message : 'error');
    return undefined;
  }
}
