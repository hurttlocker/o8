import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import os from 'node:os';
import { listRepos } from '@/lib/repos/registry';
import {
  ensureGitHubPullRequests,
  fetchGitHubPullRequestSummaries,
  fetchGitHubWorkflowRuns,
  normalizeRepoSlug,
} from '@/lib/github-broker';
/* eslint-disable @typescript-eslint/no-explicit-any -- runtime JSONL payloads vary by provider and are normalized defensively */

// /api/panel/timeline — Aggregates today's agent activity into timeline segments.
// Reads JSONL session files from the supported local runtimes:
//   1. Claude Code  ~/.claude/projects/{proj}/{session}.jsonl
//   2. Codex  ~/.codex/sessions/YYYY/MM/DD/rollout-{id}.jsonl

interface TimelineSegment {
  kind: 'thinking' | 'coding' | 'testing' | 'error' | 'idle';
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
  errorMessage?: string;
}

interface TimelineMilestone {
  kind: 'pr_review' | 'pr_blocked' | 'pr_merged' | 'ci_success' | 'ci_failure' | 'ci_running';
  atMin: number;
  title: string;
  repo: string;
  branch?: string;
  detail?: string;
  number?: number;
  runId?: number;
  url?: string;
}

function execQuiet(cmd: string, opts?: { timeout?: number; maxBuffer?: number }): string {
  try {
    return execSync(cmd, {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 8000,
      maxBuffer: opts?.maxBuffer ?? 2 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    }).trim();
  } catch {
    return '';
  }
}

// How many trailing lines to read per session file. Each line is one JSONL
// event (tool call, message, response). Heavy 14h orchestrator sessions
// can hit 35k+ lines; 500 was clipping ~99% of the day's history off the
// left side of the strip. 15k covers ~6h of a continuous heavy session
// while staying inside the 15s + 32MB exec budget.
const SESSION_TAIL_LINES = 15000;
const SESSION_TAIL_TIMEOUT_MS = 15000;
const SESSION_TAIL_MAX_BUFFER = 32 * 1024 * 1024;

type SegmentKind = 'thinking' | 'coding' | 'testing' | 'error' | 'idle';

const TEST_PATTERNS = [
  'tsc --noemit',
  'npm test',
  'npm run test',
  'pnpm test',
  'pnpm run test',
  'yarn test',
  'jest',
  'vitest',
  'playwright',
  'cypress',
  'pytest',
  'go test',
  'cargo test',
  'eslint',
  'npm run lint',
  'pnpm lint',
  'npm run build',
  'pnpm build',
];

const ERROR_PATTERNS = [
  /process exited with code [1-9]/,
  /exit code[:\s]+[1-9]/,
  /exit:\s*[1-9]/,
  /\bfatal:/,
  /\bpanic:/,
  /\btraceback\b/,
  /\bexception\b/,
  /\bpermission denied\b/,
  /\bcommand failed\b/,
  /\bnpm err!\b/,
  /\berror:\b/,
  /\berrors:\b/,
  /\bfailed\b/,
  /\bsegmentation fault\b/,
];

const ERROR_IGNORE_PATTERNS = [
  /process exited with code 0/,
  /exit code[:\s]+0/,
  /exit:\s*0/,
  /\b0 failed\b/,
  /\b0 errors\b/,
  /\bno errors?\b/,
  /\bwithout errors\b/,
  /\bsuccess(?:fully)?\b/,
  /\ball checks passed\b/,
  /\btests passed\b/,
];

function flattenUnknown(value: unknown, depth = 0): string {
  if (value == null || depth > 3) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenUnknown(item, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => flattenUnknown(item, depth + 1))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function looksLikeTesting(text: string) {
  const lc = text.toLowerCase();
  return TEST_PATTERNS.some((pattern) => lc.includes(pattern));
}

function looksLikeRealError(text: string) {
  const lc = text.toLowerCase();
  if (!lc.trim()) return false;
  if (!ERROR_PATTERNS.some((pattern) => pattern.test(lc))) return false;
  return !ERROR_IGNORE_PATTERNS.some((pattern) => pattern.test(lc));
}

function explicitFailureFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value !== 'string') return false;
  const lc = value.toLowerCase();
  return lc === 'failed' || lc === 'failure' || lc === 'error' || lc === 'errored';
}

function toWindowMinute(timestamp: string | null | undefined, todayStart: Date, windowMinutes: number) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || date < todayStart) return null;
  const minute = Math.floor((date.getTime() - todayStart.getTime()) / 60000);
  if (minute < 0 || minute > windowMinutes) return null;
  return minute;
}

async function resolveTimelineRepos() {
  const repos = await listRepos().catch(() => []);
  const ordered = new Set<string>();
  const preferred = process.env.CORTEX_IDE_REVIEW_REPO ?? '';
  if (/^[\w.-]+\/[\w.-]+$/.test(preferred)) ordered.add(preferred);

  for (const repo of repos) {
    const slug = normalizeRepoSlug(repo.remoteUrl);
    if (slug) ordered.add(slug);
    if (ordered.size >= 2) break;
  }

  return Array.from(ordered).slice(0, 2);
}

async function collectTimelineMilestones(todayStart: Date, windowMinutes: number): Promise<TimelineMilestone[]> {
  const repos = await resolveTimelineRepos();
  if (repos.length === 0) return [];

  const milestones: TimelineMilestone[] = [];

  await Promise.all(repos.map(async (repo) => {
    const [openPrsResult, closedPrsResult, ciRunsResult] = await Promise.allSettled([
      ensureGitHubPullRequests(repo),
      fetchGitHubPullRequestSummaries(repo, { states: ['closed'], limitPerState: 4 }),
      fetchGitHubWorkflowRuns(repo, 6),
    ]);

    if (openPrsResult.status === 'fulfilled') {
      const prs = openPrsResult.value.prs ?? [];
      for (const pr of prs.slice(0, 4)) {
        const atMin = toWindowMinute(pr.updatedAt ?? pr.createdAt, todayStart, windowMinutes);
        if (atMin === null) continue;

        if (pr.reviewDecision === 'CHANGES_REQUESTED') {
          milestones.push({
            kind: 'pr_blocked',
            atMin,
            title: `PR #${pr.number} changes requested`,
            detail: pr.title,
            repo,
            branch: pr.headRefName ?? '',
            number: pr.number,
            url: pr.url ?? '',
          });
          continue;
        }

        if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'APPROVED') {
          milestones.push({
            kind: 'pr_review',
            atMin,
            title: `PR #${pr.number} ${pr.reviewDecision === 'APPROVED' ? 'approved' : 'review ready'}`,
            detail: pr.title,
            repo,
            branch: pr.headRefName ?? '',
            number: pr.number,
            url: pr.url ?? '',
          });
        }
      }
    }

    if (closedPrsResult.status === 'fulfilled') {
      for (const pr of closedPrsResult.value.slice(0, 4)) {
        const atMin = toWindowMinute(pr.mergedAt ?? pr.createdAt, todayStart, windowMinutes);
        if (atMin === null || !pr.mergedAt) continue;
        milestones.push({
          kind: 'pr_merged',
          atMin,
          title: `PR #${pr.number} merged`,
          detail: pr.title,
          repo,
          branch: pr.headRefName ?? '',
          number: pr.number,
          url: pr.url ?? '',
        });
      }
    }

    if (ciRunsResult.status === 'fulfilled') {
      for (const run of ciRunsResult.value.slice(0, 5)) {
        const atMin = toWindowMinute(run.updatedAt || run.createdAt, todayStart, windowMinutes);
        if (atMin === null) continue;

        const kind = run.status === 'in_progress' || run.status === 'queued'
          ? 'ci_running'
          : run.conclusion === 'failure'
            ? 'ci_failure'
            : run.conclusion === 'success'
              ? 'ci_success'
              : null;
        if (!kind) continue;

        milestones.push({
          kind,
          atMin,
          title: kind === 'ci_running'
            ? `CI running · ${run.workflowName || run.displayTitle || 'Workflow'}`
            : kind === 'ci_failure'
              ? `CI failed · ${run.workflowName || run.displayTitle || 'Workflow'}`
              : `CI passed · ${run.workflowName || run.displayTitle || 'Workflow'}`,
          detail: run.displayTitle || run.headBranch || '',
          repo,
          branch: run.headBranch ?? '',
          runId: run.databaseId,
          url: run.url ?? '',
        });
      }
    }
  }));

  return milestones
    .sort((a, b) => a.atMin - b.atMin)
    .slice(-12);
}

/** Classify Claude Code JSONL messages — content blocks include tool_use / tool_result */
function classifyClaudeCode(entry: any): SegmentKind {
  const type = entry.type || '';
  const content = entry.message?.content;

  // system/progress/file-history = idle noise
  if (type === 'system' || type === 'progress' || type === 'file-history-snapshot' || type === 'queue-operation') {
    return 'idle';
  }

  // User messages = thinking (giving direction)
  if (type === 'user') {
    // Tool results come back as user messages with tool_result content blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const blockText = flattenUnknown(block);
          if (explicitFailureFlag(block.is_error) || looksLikeRealError(blockText)) return 'error';
          if (looksLikeTesting(blockText)) return 'testing';
          return 'coding';
        }
      }
    }
    return 'thinking';
  }

  // Assistant messages — check for tool_use blocks
  if (type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use') {
        const name = (block.name || '').toLowerCase();
        const cmd = flattenUnknown(block.input);
        if (looksLikeTesting(`${name} ${cmd}`)) return 'testing';
        return 'coding';
      }
    }
    // Text-only assistant message = thinking
    const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join(' ');
    if (looksLikeRealError(text)) return 'error';
    if (text.length < 150) return 'coding'; // short narration between tools
    return 'thinking';
  }

  return 'thinking';
}

/** Classify Codex JSONL messages */
function classifyCodex(entry: any): SegmentKind {
  const type = entry.type || '';
  const payload = entry.payload || {};
  const payloadType = payload.type || '';

  // Session meta, turn context = not activity
  if (type === 'session_meta' || type === 'turn_context') return 'idle';

  // Function calls and their output = coding
  if (type === 'response_item') {
    if (payloadType === 'function_call' || payloadType === 'function_call_output') {
      const name = String(payload.name || '').toLowerCase();
      const args = flattenUnknown(payload.arguments);
      const output = flattenUnknown(payload.output);
      if (explicitFailureFlag(payload.error) || explicitFailureFlag(payload.is_error) || explicitFailureFlag(payload.exit_code)) {
        return 'error';
      }
      if (looksLikeRealError(`${args} ${output}`)) return 'error';
      if (looksLikeTesting(`${name} ${args} ${output}`)) return 'testing';
      return 'coding';
    }
    if (payloadType === 'message') {
      const role = payload.role || '';
      const text = flattenUnknown(payload.content);
      if (looksLikeRealError(text)) return 'error';
      if (role === 'user' || role === 'developer') return 'thinking';
      return 'coding'; // assistant messages during a turn
    }
  }

  // Event messages
  if (type === 'event_msg') {
    if (payloadType === 'error' || explicitFailureFlag(payload.status) || explicitFailureFlag(payload.outcome)) {
      return 'error';
    }
    if (payloadType === 'task_complete' || payloadType === 'task_started') return 'coding';
    if (payloadType === 'agent_message') return 'coding';
    return 'thinking';
  }

  return 'thinking';
}

/** Pull the first ERROR_PATTERN-matched line from an entry's text. */
function extractErrorSnippet(entry: any): string | undefined {
  const text = flattenUnknown(entry);
  if (!text) return undefined;
  const candidates = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of candidates) {
    const lc = line.toLowerCase();
    if (!ERROR_PATTERNS.some((pattern) => pattern.test(lc))) continue;
    if (ERROR_IGNORE_PATTERNS.some((pattern) => pattern.test(lc))) continue;
    // Trim noisy prefixes / hard cap so the hover card stays readable.
    return line.length > 180 ? `${line.slice(0, 177)}…` : line;
  }
  return undefined;
}

/** Generic segment accumulator — shared by all three runtimes */
function accumulateSegments(
  lines: string,
  todayStart: Date,
  agent: string,
  classifier: (entry: any) => SegmentKind,
  extractTimestamp: (entry: any) => string | undefined,
): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let currentKind: string | null = null;
  let blockStart = 0;
  let blockDur = 0;
  let blockErrorMessage: string | undefined;
  let hasToday = false;

  const flushBlock = () => {
    if (currentKind === null) return;
    segments.push({
      kind: currentKind as SegmentKind,
      startMin: blockStart,
      durationMin: Math.max(blockDur, 1),
      agent,
      ...(currentKind === 'error' && blockErrorMessage ? { errorMessage: blockErrorMessage } : {}),
    });
  };

  for (const line of lines.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const ts = extractTimestamp(entry);
      if (!ts) continue;

      const msgTime = new Date(ts);
      if (isNaN(msgTime.getTime()) || msgTime < todayStart) continue;
      hasToday = true;

      const minSinceStart = Math.floor((msgTime.getTime() - todayStart.getTime()) / 60000);
      const kind = classifier(entry);

      if (currentKind === null) {
        currentKind = kind;
        blockStart = minSinceStart;
        blockDur = 1;
        blockErrorMessage = kind === 'error' ? extractErrorSnippet(entry) : undefined;
      } else if (kind === currentKind && minSinceStart - (blockStart + blockDur) < 3) {
        blockDur = Math.max(blockDur, minSinceStart - blockStart + 1);
        if (kind === 'error' && !blockErrorMessage) {
          blockErrorMessage = extractErrorSnippet(entry);
        }
      } else {
        const gapMin = minSinceStart - (blockStart + blockDur);
        flushBlock();
        if (gapMin >= 5) {
          segments.push({ kind: 'idle', startMin: blockStart + blockDur, durationMin: gapMin, agent });
        }
        currentKind = kind;
        blockStart = minSinceStart;
        blockDur = 1;
        blockErrorMessage = kind === 'error' ? extractErrorSnippet(entry) : undefined;
      }
    } catch { continue; }
  }

  if (hasToday) flushBlock();

  return segments;
}

export async function GET() {
  try {
    const now = new Date();
    // True 24h rolling window: right edge = now, left edge = now − 24h.
    // The strip never resets — activity slides off the left as new minutes
    // tick by on the right. Survives late-night work and time-zone drift.
    const todayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const windowMinutes = 24 * 60;

    const home = os.homedir();
    const allSegments: TimelineSegment[] = [];
    const milestones = await collectTimelineMilestones(todayStart, windowMinutes).catch(() => []);

    // ── 2. Claude Code sessions ──
    const ccFiles = execQuiet(`ls -t ${home}/.claude/projects/*/*.jsonl 2>/dev/null | head -10`);
    for (const file of ccFiles.split('\n').filter(Boolean)) {
      // Extract project name from path: ~/.claude/projects/-Users-foo-bar/session.jsonl → bar
      const projMatch = file.match(/projects\/([^/]+)\//);
      const projEncoded = projMatch ? projMatch[1] : '';
      const projName = projEncoded.split('-').filter(Boolean).pop() || 'claude-code';
      const agent = `cc:${projName}`;

      const lines = execQuiet(`tail -${SESSION_TAIL_LINES} "${file}" 2>/dev/null`, {
        timeout: SESSION_TAIL_TIMEOUT_MS,
        maxBuffer: SESSION_TAIL_MAX_BUFFER,
      });
      if (!lines) continue;

      allSegments.push(...accumulateSegments(lines, todayStart, agent, classifyClaudeCode, (e) => e.timestamp));
    }

    // ── 3. Codex sessions ──
    // Codex stores sessions in date-partitioned dirs: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
    // The rolling 24h window can straddle midnight, so always scan both
    // the window-start date AND the now date.
    const datePartition = (d: Date) =>
      `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const codexDirs = new Set([datePartition(todayStart), datePartition(now)]);
    const codexFiles: string[] = [];
    for (const dir of codexDirs) {
      const found = execQuiet(`ls -t ${home}/.codex/sessions/${dir}/*.jsonl 2>/dev/null | head -5`);
      codexFiles.push(...found.split('\n').filter(Boolean));
    }

    for (const file of codexFiles) {
      // Extract a short label from the filename
      const agent = 'codex';

      const lines = execQuiet(`tail -${SESSION_TAIL_LINES} "${file}" 2>/dev/null`, {
        timeout: SESSION_TAIL_TIMEOUT_MS,
        maxBuffer: SESSION_TAIL_MAX_BUFFER,
      });
      if (!lines) continue;

      allSegments.push(...accumulateSegments(lines, todayStart, agent, classifyCodex, (e) => e.timestamp));
    }

    if (allSegments.length === 0) {
      return NextResponse.json({
        segments: [],
        milestones,
        totalMinutes: 0,
        windowMinutes,
        anchorStartIso: todayStart.toISOString(),
        nowIso: now.toISOString(),
        source: 'none',
      });
    }

    // Sort by start time
    allSegments.sort((a, b) => a.startMin - b.startMin);

    // Pass 1: Merge adjacent same-kind segments (within 3 min gap)
    const pass1: TimelineSegment[] = [];
    for (const seg of allSegments) {
      const last = pass1[pass1.length - 1];
      if (last && last.kind === seg.kind && seg.startMin <= last.startMin + last.durationMin + 3) {
        last.durationMin = Math.max(last.durationMin, (seg.startMin + seg.durationMin) - last.startMin);
      } else {
        pass1.push({ ...seg });
      }
    }

    // Pass 2: Absorb short segments (< 3 min) into their neighbors.
    // In a real coding session, thinking→coding→thinking→coding rapidly
    // alternating should just be "coding". The dominant kind wins.
    const merged: TimelineSegment[] = [];
    for (let i = 0; i < pass1.length; i++) {
      const seg = pass1[i];
      const prev = merged[merged.length - 1];

      // If this segment is tiny and adjacent to something, absorb it.
      // Coding always wins over thinking (tool calls happen between planning messages).
      if (seg.durationMin <= 2 && seg.kind !== 'idle' && seg.kind !== 'error') {
        if (prev && prev.kind !== 'idle' && seg.startMin <= prev.startMin + prev.durationMin + 3) {
          // Extend previous to cover this, but upgrade to coding if either is coding
          if (seg.kind === 'coding' || prev.kind === 'coding') {
            prev.kind = 'coding';
          }
          prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
          continue;
        }
      }

      // Try to merge with previous
      if (prev && prev.kind === seg.kind && seg.startMin <= prev.startMin + prev.durationMin + 3) {
        prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
      } else {
        merged.push({ ...seg });
      }
    }

    // Pass 3: Final merge — any remaining non-idle segments within 5 min get merged.
    // The LONGER segment's kind wins (coding sessions absorb brief thinking pauses).
    // Errors stay separate (they're important signals) unless truly tiny (< 2 min).
    const final: TimelineSegment[] = [];
    for (const seg of merged) {
      const prev = final[final.length - 1];
      if (
        prev &&
        seg.kind !== 'idle' && prev.kind !== 'idle' &&
        seg.kind !== 'error' && prev.kind !== 'error' &&
        seg.startMin <= prev.startMin + prev.durationMin + 5
      ) {
        // Coding wins when merging (coding sessions have thinking interspersed)
        if (seg.kind === 'coding' || prev.kind === 'coding') {
          prev.kind = 'coding';
        } else if (seg.durationMin > prev.durationMin) {
          prev.kind = seg.kind;
        }
        prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
      } else {
        final.push({ ...seg });
      }
    }

    // Pass 4: strip idle spans that overlap active work and re-merge same-kind runs.
    // This removes same-minute idle/coding duplicates that can happen when multiple
    // runtime transcripts are unioned into the single top timeline lane.
    const activeRanges = final
      .filter((seg) => seg.kind !== 'idle')
      .map((seg) => ({ start: seg.startMin, end: seg.startMin + seg.durationMin }));

    const withoutIdleOverlap = final.filter((seg) => {
      if (seg.kind !== 'idle') return true;
      const start = seg.startMin;
      const end = seg.startMin + seg.durationMin;
      return !activeRanges.some((range) => start < range.end && range.start < end);
    });

    const normalized: TimelineSegment[] = [];
    for (const seg of withoutIdleOverlap) {
      const prev = normalized[normalized.length - 1];
      if (prev && prev.kind === seg.kind && seg.startMin <= prev.startMin + prev.durationMin + 3) {
        prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
      } else {
        normalized.push({ ...seg });
      }
    }

    const totalMinutes = normalized.length > 0
      ? normalized[normalized.length - 1].startMin + normalized[normalized.length - 1].durationMin
      : 0;

    // Summary stats
    const kindTotals: Record<string, number> = {};
    for (const seg of normalized) {
      kindTotals[seg.kind] = (kindTotals[seg.kind] || 0) + seg.durationMin;
    }

    return NextResponse.json({
      segments: normalized,
      milestones,
      totalMinutes,
      windowMinutes,
      anchorStartIso: todayStart.toISOString(),
      nowIso: now.toISOString(),
      stats: kindTotals,
      source: 'multi-runtime',
    });
  } catch {
    return NextResponse.json({ segments: [], error: 'internal' }, { status: 500 });
  }
}
