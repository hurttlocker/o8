import 'server-only';

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { MODEL_IDS } from '@/lib/models';
import { getDataDir } from '@/lib/data-dir-migration';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { persistCanonicalChatHistoryRecord } from '@/lib/llm/chat-history-store';
const HISTORY_DIR = path.join(getDataDir(), 'chat-history');
const ARCHIVE_DIR = path.join(getDataDir(), 'orchestrator-archives');
const inFlight = new Map<string, Promise<AutoCompactResult>>();
type PersistedThread = { filePath: string; tabId: string; payload: Record<string, unknown>; messages: MobileTranscriptEntry[]; mtimeMs: number };
export interface AutoCompactResult { applied: boolean; transcript: MobileTranscriptEntry[]; resumePrelude: string | null; tokensAfter: number; }
const fmtStamp = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
const approxTokens = (value: string) => Math.max(0, Math.ceil(value.length / 4));
const stripCompactionTags = (value: string) => value.replace(/<\/?compacted_context\b[^>]*>/gi, '').trim();
function coerceEntry(value: unknown): MobileTranscriptEntry | null {
  const record = value as Record<string, unknown> | null;
  const role = record?.role;
  return record && typeof record.id === 'string' && (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool')
    ? {
      ...(record as unknown as MobileTranscriptEntry),
      pinned: record.pinned === true,
      role,
      text: typeof record.text === 'string' ? record.text : typeof record.content === 'string' ? record.content : '',
    }
    : null;
}
async function readLatestThread(repoPath: string): Promise<PersistedThread | null> {
  const files = await readdir(HISTORY_DIR).catch(() => [] as string[]);
  const candidates = await Promise.all(files.filter((file) => file.startsWith('thoughts-') && file.endsWith('.json')).map(async (file) => {
    const filePath = path.join(HISTORY_DIR, file);
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    if (!raw) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    if ((payload.repoPath as string | undefined)?.trim() !== repoPath) return null;
    const fileStat = await stat(filePath).catch(() => null);
    const messages = Array.isArray(payload.messages) ? payload.messages.map(coerceEntry).filter(Boolean) as MobileTranscriptEntry[] : [];
    return messages.length === 0 || !fileStat ? null : {
      filePath,
      tabId: file.replace(/\.json$/, ''),
      payload,
      messages,
      mtimeMs: fileStat.mtimeMs,
    };
  }));
  return candidates.filter((candidate): candidate is PersistedThread => Boolean(candidate)).sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? null;
}
function mergeSnapshots(history: MobileTranscriptEntry[], snapshot: MobileTranscriptEntry[]) {
  if (snapshot.length === 0) return history;
  const next = [...history];
  const seen = new Set(next.map((entry) => entry.id));
  for (const entry of snapshot) {
    const index = next.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) {
      next[index] = entry;
      continue;
    }
    if (!seen.has(entry.id)) {
      next.push(entry);
      seen.add(entry.id);
    }
  }
  return next.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
}
function buildExcerpt(messages: MobileTranscriptEntry[], maxChars: number) {
  let size = 0;
  return messages.map((entry, index) => {
    const role = entry.type === 'compaction' ? 'COMPACTION' : entry.role.toUpperCase();
    const text = (entry.type === 'compaction' ? stripCompactionTags(entry.compaction?.summary ?? entry.text) : entry.text.trim()).slice(0, 1400) || '[no text]';
    const tools = entry.toolCalls?.map((tool) => tool.name).filter(Boolean).join(', ');
    return [`Turn ${index + 1} · ${role}${entry.timestampLabel ? ` · ${entry.timestampLabel}` : ''}`, text, tools ? `Tools: ${tools}` : null].filter(Boolean).join('\n');
  }).filter((chunk) => {
    size += chunk.length;
    return size <= maxChars;
  }).join('\n\n');
}
const toStoredMessage = (entry: MobileTranscriptEntry) => ({ ...entry, content: entry.text });

function splitCompactionWindow(transcript: MobileTranscriptEntry[], compactedCount: number) {
  const compactedWindow = transcript.slice(0, compactedCount);
  const compactedTurns = compactedWindow.filter((entry) => entry.pinned !== true);
  const pinnedTurns = compactedWindow.filter((entry) => entry.pinned === true);
  const liveTurns = transcript.slice(compactedCount);
  return {
    compactedTurns,
    pinnedTurns,
    liveTurns,
    retainedTurns: [...pinnedTurns, ...liveTurns],
  };
}
/**
 * Summarize a thread segment via Codex GPT-5.5 (medium reasoning effort).
 * Replaces the previous `claude --print haiku` spawn — same role (cheap fast
 * summarization), but Codex is free for ChatGPT Plus / Codex sub users and
 * doesn't bill against the Anthropic Agent SDK pool (#1046, epic #1044).
 *
 * Compaction is summarization, not orchestrator-class reasoning, so we use
 * `model_reasoning_effort=medium` — xhigh wastes wall time here. Passes
 * `--skip-git-repo-check` so codex doesn't refuse on untrusted repos (the
 * summary doesn't need git context at all).
 */
async function summarizeWithCodex(repoPath: string, prompt: string) {
  const { resolveCli } = await import('@/lib/runtimes/shared/cli-resolver');
  const codexBin = (await resolveCli({
    runtimeId: 'codex',
    binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN',
    extraEnvOverrides: ['CODEX_HOME'],
  })).path;

  // The prompt is a conversation transcript — free text. On Windows the spawn
  // has to go through cmd.exe (codex is `codex.cmd`), and cmd expands `%VAR%`
  // inside quoted arguments, so a transcript on argv is both corruptible and an
  // injection surface. Send it on stdin there instead — the same way the Brain's
  // codex adapter has always fed `codex exec`. POSIX keeps argv unchanged.
  const promptOnStdin = process.platform === 'win32';
  return await new Promise<string>((resolve, reject) => {
    const launch = cliInvocation(codexBin, [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-c',
      `model=${MODEL_IDS.codexDefault}`,
      '-c',
      'model_reasoning_effort=medium',
      '-C',
      repoPath,
      ...(promptOnStdin ? [] : [prompt]),
    ]);
    const child = spawn(
      launch.command,
      launch.args,
      {
        windowsHide: true,
        cwd: repoPath,
        stdio: [promptOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' },
      },
    );
    if (promptOnStdin) {
      child.stdin?.write(prompt, 'utf-8');
      child.stdin?.end();
    }
    let buffer = '';
    let stderr = '';
    let result = '';
    // stdio[1]/stdio[2] are always 'pipe' above; only stdin varies by platform,
    // which is enough to cost the tuple its literal type.
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // codex-cli 0.130.0 emits the final reply as item.completed with
          // item.type='agent_message' and the body on item.text. Older builds
          // use event_msg/agent_message — both accepted, same way codex-
          // orchestrator-session.ts handles them.
          const item = parsed.item as Record<string, unknown> | undefined;
          if (parsed.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
            result = item.text;
          } else if (parsed.type === 'event_msg') {
            const payload = parsed.payload as Record<string, unknown> | undefined;
            if (payload?.type === 'agent_message' && typeof payload.message === 'string') {
              result = payload.message;
            }
          }
        } catch {
          // ignore partial lines / non-JSON banner output
        }
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      const text = result.trim();
      if (code === 0 && text) resolve(text);
      else reject(new Error(stderr.trim() || `Codex compaction failed (${code ?? 'unknown'})`));
    });
  });
}
// ── digest() — Fable Slice 5 (2026-07-02) ────────────────────────────────────

export interface DigestResult {
  digest: string;
  approxInputTokens: number;
  approxDigestTokens: number;
  truncatedInput: boolean;
}

/** Argv-safety cap — the prompt rides as a single codex argv element. */
const DIGEST_INPUT_CHAR_CAP = 180_000;

/**
 * Pre-digest arbitrary bulk (logs, test output, a diff, docs, a transcript)
 * into the smallest faithful summary a decision-maker can act on — the
 * metered-orchestrator window's inbound-bulk lever (lever 4). Runs on the same
 * Codex-medium engine as compaction, at $0 marginal (fixed sub).
 *
 * Adversarial digestion (Q synthesis #3): every call spawns a FRESH read-only
 * codex exec — the digest never comes from the proposing worker's session, so
 * no summarizer grades its own work.
 */
export async function digest(text: string, repoPath: string): Promise<DigestResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('digest: text is required');
  const truncatedInput = trimmed.length > DIGEST_INPUT_CHAR_CAP;
  const capped = truncatedInput
    ? `${trimmed.slice(0, DIGEST_INPUT_CHAR_CAP)}\n[... input truncated at ${DIGEST_INPUT_CHAR_CAP} chars ...]`
    : trimmed;
  const summary = await summarizeWithCodex(repoPath, [
    'Digest the following material into the smallest faithful summary a decision-maker can act on. Use exactly these sections with terse bullets:',
    'What this is',
    'Key facts / findings',
    'Errors or failures (keep load-bearing lines verbatim)',
    'Decisions needed',
    'Use file paths, symbols, and numbers verbatim. If a section is empty, write "- None." Do not editorialize or add recommendations beyond the material.',
    '',
    capped,
  ].join('\n'));
  return {
    digest: summary,
    approxInputTokens: approxTokens(capped),
    approxDigestTokens: approxTokens(summary),
    truncatedInput,
  };
}

export async function autoCompactOrchestratorThread(input: {
  repoPath: string;
  liveMessages?: MobileTranscriptEntry[];
  runningTotal?: number;
  keepTailCount?: number;
  trigger?: 'auto' | 'manual' | 'handoff';
}): Promise<AutoCompactResult> {
  const repoPath = input.repoPath.trim();
  const snapshot = Array.isArray(input.liveMessages) ? input.liveMessages.map(coerceEntry).filter(Boolean) as MobileTranscriptEntry[] : [];
  if (!repoPath) return { applied: false, transcript: snapshot, resumePrelude: null, tokensAfter: 0 };

  // Gate background LLM work on the in-app orchestrator toggle (#1046, epic
  // #1044). Toggle ON means user has at least one sub (Codex) and wants the
  // background performance features. Toggle OFF means we silently skip
  // compaction — the thread keeps growing but no LLM calls happen.
  const { resolveInAppOrchestratorEnabledSync } = await import('@/lib/operator/defaults');
  if (!resolveInAppOrchestratorEnabledSync()) {
    return { applied: false, transcript: snapshot, resumePrelude: null, tokensAfter: 0 };
  }
  const existing = inFlight.get(repoPath);
  if (existing) return existing;
  const job = (async () => {
    const thread = await readLatestThread(repoPath);
    const transcript = mergeSnapshots(thread?.messages ?? [], snapshot);
    if (transcript.length < 2) return { applied: false, transcript, resumePrelude: null, tokensAfter: 0 };
    const keepTailCount = typeof input.keepTailCount === 'number' && Number.isFinite(input.keepTailCount)
      ? Math.max(1, Math.floor(input.keepTailCount))
      : null;
    if (keepTailCount !== null && transcript.length <= keepTailCount + 1) {
      return { applied: false, transcript, resumePrelude: null, tokensAfter: 0 };
    }
    const compactedCount = keepTailCount !== null
      ? Math.max(1, transcript.length - keepTailCount)
      : Math.max(1, Math.floor(transcript.length * 0.6));
    const { compactedTurns, pinnedTurns, liveTurns, retainedTurns } = splitCompactionWindow(transcript, compactedCount);
    if (compactedTurns.length === 0) {
      return { applied: false, transcript, resumePrelude: null, tokensAfter: 0 };
    }
    const compactedAt = new Date();
    const compactedStamp = fmtStamp(compactedAt);
    const summary = await summarizeWithCodex(repoPath, ['Summarize this orchestrator thread segment using exactly these sections and terse bullets:', 'Decisions made', 'Files touched', 'Open questions', 'Current mission state', 'Use file paths verbatim. If a section is empty, write "- None."', '', buildExcerpt(compactedTurns, 90_000)].join('\n'));
    const displaySummary = `<compacted_context turns="${compactedTurns.length}" at="${compactedStamp}">\n${summary}\n</compacted_context>`;
    const compactionEntry: MobileTranscriptEntry = {
      id: `orch-compaction-${compactedAt.getTime()}`,
      role: 'system',
      text: 'Context compaction event',
      type: 'compaction',
      timestamp: compactedAt.getTime(),
      timestampLabel: compactedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      compaction: {
        timestamp: compactedAt.getTime(),
        tokensBefore: typeof input.runningTotal === 'number' ? input.runningTotal : undefined,
        tokensAfter: undefined,
        trigger: input.trigger === 'handoff' ? 'manual' : input.trigger ?? 'auto',
        source: 'summary',
        summary: displaySummary,
      },
    };
    const nextTranscript = [compactionEntry, ...pinnedTurns, ...liveTurns];
    const resumePrelude = [`Compaction summary (${compactedStamp})`, summary, '', 'Most recent uncompressed turns:', buildExcerpt(retainedTurns, 80_000) || '- None.', '', 'Continue from that context. The operator message follows below.'].join('\n');
    const tokensAfter = approxTokens(resumePrelude);
    compactionEntry.compaction!.tokensAfter = tokensAfter;
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await writeFile(path.join(ARCHIVE_DIR, `${thread?.tabId ?? 'thoughts'}-${compactionEntry.id}.json`), JSON.stringify({
      repoPath,
      tabId: thread?.tabId ?? null,
      archivedAt: compactedAt.toISOString(),
      compactedCount: compactedTurns.length,
      turns: compactedTurns.map(toStoredMessage),
      summary,
    }));
    if (thread) {
      persistCanonicalChatHistoryRecord(thread.tabId, {
        ...thread.payload,
        messages: nextTranscript.map(toStoredMessage),
        savedAt: compactedAt.toISOString(),
      });
    }
    return { applied: true, transcript: nextTranscript, resumePrelude, tokensAfter };
  })().finally(() => {
    inFlight.delete(repoPath);
  });
  inFlight.set(repoPath, job);
  return job;
}
