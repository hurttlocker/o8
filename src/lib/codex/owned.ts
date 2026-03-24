import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { isTmuxAvailable, tmuxSessionName, createTmuxSession } from '@/lib/terminal/tmux';
import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeReviewCommandEvidence,
  RuntimeReviewPacket,
  RuntimeSurfaceLifecycle,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';

const execFileAsync = promisify(execFile);
const OWNED_CODEX_ROOT = process.env.CORTEX_IDE_OWNED_CODEX_ROOT || path.join(os.homedir(), '.cortex-ide', 'owned-codex');
const RUNS_DIR = 'runs';
const METADATA_FILE = 'session.json';
const ACTIVE_WINDOW_MS = 10 * 60_000;
const RECENT_WINDOW_MS = 6 * 60 * 60_000;
const OWNED_CODEX_FLEET_TTL_MS = 20_000;

type OwnedRunMode = 'launch' | 'resume';
type OwnedRunOutcome = 'running' | 'finished' | 'interrupted' | 'failed';

export type OwnedCodexLaunchRequest = {
  cwd: string;
  prompt: string;
};

export type OwnedCodexLaunchResponse = {
  ok: boolean;
  runtime: 'codex';
  surfaceId: string;
  note: string;
};

type OwnedCodexRunRecord = {
  id: string;
  mode: OwnedRunMode;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  outcome: OwnedRunOutcome;
  interruptRequestedAt?: string;
  tmuxSession?: string;
};

type OwnedReviewDisposition = 'watching' | 'resolved';

type OwnedCodexSessionRecord = {
  surfaceId: string;
  sessionDir: string;
  cwd: string;
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  latestPrompt: string;
  latestSummary: string;
  reviewDisposition?: OwnedReviewDisposition;
  reviewDispositionUpdatedAt?: string;
  activeRun?: OwnedCodexRunRecord;
  recentRuns: OwnedCodexRunRecord[];
  autoRetry?: boolean;
  retryCount?: number;
};

type OwnedCodexFleetAdditions = {
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
  ownedThreadIds: string[];
};

let ownedFleetCache: { value: OwnedCodexFleetAdditions; cachedAt: number } | null = null;
let ownedFleetInflight: Promise<OwnedCodexFleetAdditions> | null = null;
let ownedFleetGeneration = 0;

export function invalidateOwnedCodexFleetCache() {
  ownedFleetGeneration += 1;
  ownedFleetCache = null;
  ownedFleetInflight = null;
}

type OwnedTailEntry = {
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  label: string;
  text: string;
  timestampLabel?: string;
};

type OwnedTailGroup = {
  id: string;
  title: string;
  mode: OwnedRunMode;
  outcome: OwnedRunOutcome;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  startedAtLabel?: string;
  finishedAtLabel?: string;
  summary: string;
  entries: OwnedTailEntry[];
};

type ParsedRunLog = {
  threadId?: string;
  entries: OwnedTailEntry[];
  outcome: OwnedRunOutcome;
  completedTurn: boolean;
};

type ParsedRunEvidence = {
  assistantSummary?: string;
  commands: RuntimeReviewCommandEvidence[];
};

function nowIso() {
  return new Date().toISOString();
}

function compactText(value: string | null | undefined, max = 120) {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

function previewText(value: string | null | undefined, max = 260) {
  const compact = compactText(value, max);
  return compact || undefined;
}

function relativeAge(timestampIso?: string) {
  if (!timestampIso) return 'just now';
  const ageMs = Math.max(0, Date.now() - new Date(timestampIso).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

function formatClock(timestampIso?: string) {
  if (!timestampIso) return undefined;
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function shortHome(value: string) {
  return value.replace(`${os.homedir()}/`, '~/');
}

function metadataPath(sessionDir: string) {
  return path.join(sessionDir, METADATA_FILE);
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(target: string) {
  await mkdir(target, { recursive: true });
}

async function readJsonFile<T>(filePath: string) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureOwnedRoot() {
  await ensureDir(OWNED_CODEX_ROOT);
  return OWNED_CODEX_ROOT;
}

function isPidAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function validateWorkspace(targetCwd: string) {
  // Expand ~ to home directory (client sends ~/clawd/repos/... format)
  const expanded = targetCwd.startsWith('~/') ? path.join(os.homedir(), targetCwd.slice(2)) : targetCwd;
  const resolved = path.resolve(expanded);
  const real = await realpath(resolved).catch(() => resolved);
  if (!real.startsWith(path.join(os.homedir(), 'clawd'))) {
    throw new Error('Owned Codex launch is currently restricted to paths under ~/clawd.');
  }

  const { stdout } = await execFileAsync('git', ['-C', real, 'rev-parse', '--show-toplevel'], {
    maxBuffer: 256 * 1024,
  });
  return path.resolve(stdout.trim());
}

async function gitValue(repoPath: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      maxBuffer: 256 * 1024,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function repoSlugFromOrigin(origin?: string) {
  const value = (origin ?? '').trim();
  if (!value) return undefined;
  const httpsMatch = value.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) return httpsMatch[1];
  const sshMatch = value.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (sshMatch?.[1]) return sshMatch[1];
  return undefined;
}

async function resolveRepoContext(repoPath: string) {
  const [branch, head, origin] = await Promise.all([
    gitValue(repoPath, ['branch', '--show-current']),
    gitValue(repoPath, ['rev-parse', 'HEAD']),
    gitValue(repoPath, ['remote', 'get-url', 'origin']),
  ]);

  const repoSlug = repoSlugFromOrigin(origin);
  const repoName = repoSlug?.split('/').pop() ?? path.basename(repoPath);
  const title = branch ? `${repoName} • ${branch}` : repoName;

  return {
    repoPath,
    repoSlug,
    branch,
    head,
    title,
  };
}

function runArgsForLaunch(repoPath: string, prompt: string) {
  return ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-C', repoPath, prompt];
}

function runArgsForResume(threadId: string, prompt: string) {
  return ['exec', 'resume', threadId, '--json', '--dangerously-bypass-approvals-and-sandbox', prompt];
}

async function loadOwnedSession(sessionDir: string) {
  return readJsonFile<OwnedCodexSessionRecord>(metadataPath(sessionDir));
}

async function saveOwnedSession(session: OwnedCodexSessionRecord) {
  session.updatedAt = nowIso();
  await writeJsonFile(metadataPath(session.sessionDir), session);
}

function parseOwnedRunLog(raw: string, run: OwnedCodexRunRecord): ParsedRunLog {
  const entries: OwnedTailEntry[] = [
    {
      id: `${run.id}:prompt`,
      kind: 'message',
      label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
      text: compactText(run.prompt, 400),
      timestampLabel: formatClock(run.startedAt),
    },
  ];
  let threadId: string | undefined;
  let noiseIndex = 0;
  let completedTurn = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = String(parsed.type ?? '');

      if (type === 'thread.started') {
        threadId = String(parsed.thread_id ?? '') || threadId;
        continue;
      }

      if (type === 'turn.started') {
        entries.push({
          id: `${run.id}:turn-start:${entries.length}`,
          kind: 'event',
          label: 'Run started',
          text: run.mode === 'launch' ? 'Owned Codex run launched from Cortex IDE.' : 'Owned Codex session resumed from Cortex IDE.',
          timestampLabel: formatClock(run.startedAt),
        });
        continue;
      }

      if (type === 'item.completed') {
        const item = (parsed.item ?? {}) as Record<string, unknown>;
        if (item.type === 'agent_message') {
          const text = compactText(String(item.text ?? ''), 500);
          if (text) {
            entries.push({
              id: `${run.id}:message:${entries.length}`,
              kind: 'message',
              label: 'Assistant',
              text,
              timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
            });
          }
          continue;
        }

        if (item.type === 'command_execution') {
          const command = String(item.command ?? '').trim();
          const output = compactText(String(item.aggregated_output ?? ''), 500);

          entries.push({
            id: `${run.id}:tool:${String(item.id ?? entries.length)}`,
            kind: 'tool',
            label: 'exec_command',
            text: command ? JSON.stringify({ command }) : '',
            timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
          });

          if (output) {
            entries.push({
              id: `${run.id}:tool-output:${String(item.id ?? entries.length)}`,
              kind: 'tool-output',
              label: 'Tool output',
              text: output,
              timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
            });
          }
          continue;
        }
      }

      if (type === 'turn.completed') {
        completedTurn = true;
        const usage = (parsed.usage ?? {}) as Record<string, unknown>;
        const usageBits = [
          usage.input_tokens ? `${usage.input_tokens} in` : null,
          usage.cached_input_tokens ? `${usage.cached_input_tokens} cached` : null,
          usage.output_tokens ? `${usage.output_tokens} out` : null,
        ].filter(Boolean);
        entries.push({
          id: `${run.id}:turn-complete:${entries.length}`,
          kind: 'event',
          label: 'Turn completed',
          text: usageBits.length ? `Usage • ${usageBits.join(' • ')}` : 'Run completed.',
          timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
        });
        continue;
      }
    } catch {
      entries.push({
        id: `${run.id}:noise:${noiseIndex += 1}`,
        kind: 'event',
        label: 'Runtime',
        text: compactText(trimmed, 500),
        timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
      });
    }
  }

  const outcome = run.outcome === 'running'
    ? completedTurn
      ? 'finished'
      : run.interruptRequestedAt
        ? 'interrupted'
        : 'running'
    : run.outcome;

  return {
    threadId,
    entries,
    outcome,
    completedTurn,
  };
}

function parseOwnedRunEvidence(raw: string, run: OwnedCodexRunRecord, resolvedOutcome?: OwnedRunOutcome): ParsedRunEvidence {
  let assistantSummary: string | undefined;
  const commands = [] as RuntimeReviewCommandEvidence[];
  const finalOutcome = resolvedOutcome ?? run.outcome;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type !== 'item.started' && parsed.type !== 'item.completed') {
        continue;
      }

      const item = (parsed.item ?? {}) as Record<string, unknown>;
      if (item.type === 'agent_message' && parsed.type === 'item.completed') {
        assistantSummary = previewText(String(item.text ?? ''), 220) ?? assistantSummary;
        continue;
      }

      if (item.type !== 'command_execution') {
        continue;
      }

      const itemId = String(item.id ?? `${run.id}:${commands.length}`);
      const current = commands.find((entry) => entry.id === itemId);
      const baseStatus = parsed.type === 'item.started' ? 'running' : 'completed';
      const exitCode = item.exit_code == null ? null : Number(item.exit_code);
      const nextStatus = finalOutcome === 'interrupted'
        ? 'interrupted'
        : parsed.type === 'item.completed' && exitCode && exitCode !== 0
          ? 'failed'
          : finalOutcome === 'failed' && parsed.type !== 'item.completed'
            ? 'failed'
            : baseStatus;
      const nextEntry: RuntimeReviewCommandEvidence = {
        id: itemId,
        command: previewText(String(item.command ?? ''), 180) ?? 'command',
        status: nextStatus,
        exitCode,
        outputPreview: previewText(String(item.aggregated_output ?? ''), 260),
      };

      if (current) {
        Object.assign(current, nextEntry);
      } else {
        commands.push(nextEntry);
      }
    } catch {
      continue;
    }
  }

  if (finalOutcome !== 'running') {
    for (const command of commands) {
      if (command.status !== 'running') continue;
      command.status = finalOutcome === 'finished'
        ? 'completed'
        : finalOutcome === 'interrupted'
          ? 'interrupted'
          : 'failed';
    }
  }

  return {
    assistantSummary,
    commands,
  };
}

async function readRunArtifacts(run: OwnedCodexRunRecord) {
  const [stdoutRaw, stderrRaw] = await Promise.all([
    pathExists(run.stdoutPath).then((exists) => (exists ? readFile(run.stdoutPath, 'utf8').catch(() => '') : '')),
    pathExists(run.stderrPath).then((exists) => (exists ? readFile(run.stderrPath, 'utf8').catch(() => '') : '')),
  ]);

  return {
    stdoutRaw,
    stderrRaw,
    parsed: parseOwnedRunLog(stdoutRaw, run),
  };
}

function deriveRunOutcome(run: OwnedCodexRunRecord, parsed: ParsedRunLog, stderrRaw: string): OwnedRunOutcome {
  if (run.outcome === 'interrupted' || run.interruptRequestedAt) {
    return 'interrupted';
  }
  if (parsed.completedTurn) {
    return 'finished';
  }
  const stderrText = stderrRaw.toLowerCase();
  if (stderrText.includes('panic') || stderrText.includes('fatal') || stderrText.includes('error')) {
    return 'failed';
  }
  return run.outcome === 'running' ? 'failed' : run.outcome;
}

function latestFinishedRun(session: OwnedCodexSessionRecord) {
  return [...session.recentRuns]
    .filter((run) => run.outcome !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))[0];
}

function deriveLifecycle(session: OwnedCodexSessionRecord): RuntimeSurfaceLifecycle {
  const activeRun = session.activeRun && isPidAlive(session.activeRun.pid) ? session.activeRun : undefined;
  const latest = latestFinishedRun(session);

  if (activeRun) {
    return {
      availability: 'running',
      lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed'
        ? latest.outcome
        : undefined,
      lastRunMode: activeRun.mode,
      lastRunStartedAt: activeRun.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: 'Active owned run in flight.',
    };
  }

  if (!session.threadId) {
    return {
      availability: 'awaiting-thread',
      lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed'
        ? latest.outcome
        : undefined,
      lastRunMode: latest?.mode,
      lastRunStartedAt: latest?.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: 'Waiting for the first persistent Codex thread id before resume is available.',
    };
  }

  return {
    availability: 'ready-for-resume',
    lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed'
      ? latest.outcome
      : undefined,
    lastRunMode: latest?.mode,
    lastRunStartedAt: latest?.startedAt,
    lastRunFinishedAt: latest?.finishedAt,
    summary: latest?.outcome === 'interrupted'
      ? 'Previous run was interrupted. This owned session is ready for the next bounded input.'
      : latest?.outcome === 'failed'
        ? 'Previous run failed. This owned session is ready for a corrective follow-up.'
        : 'Owned session is idle between runs and ready for the next bounded input.',
  };
}

function lifecycleAvailabilityLabel(availability?: RuntimeSurfaceLifecycle['availability']) {
  switch (availability) {
    case 'running':
      return 'running';
    case 'awaiting-thread':
      return 'awaiting thread';
    case 'ready-for-resume':
      return 'ready for resume';
    default:
      return 'unknown';
  }
}

async function refreshOwnedSession(session: OwnedCodexSessionRecord) {
  let dirty = false;

  for (const run of session.recentRuns) {
    const { stderrRaw, parsed } = await readRunArtifacts(run);

    if (!session.threadId && parsed.threadId) {
      session.threadId = parsed.threadId;
      dirty = true;
    }

    const runAlive = isPidAlive(run.pid);
    if (runAlive) {
      if (run.outcome !== 'running') {
        run.outcome = 'running';
        dirty = true;
      }
      continue;
    }

    const nextOutcome = deriveRunOutcome(run, parsed, stderrRaw);
    if (run.outcome !== nextOutcome) {
      run.outcome = nextOutcome;
      dirty = true;
    }
    if (!run.finishedAt) {
      run.finishedAt = nowIso();
      dirty = true;
    }
  }

  if (session.activeRun && !isPidAlive(session.activeRun.pid)) {
    session.activeRun = undefined;
    dirty = true;
  }

  if (dirty) {
    await saveOwnedSession(session);
  }

  // Auto-retry: if the latest run just failed and autoRetry is enabled, retry once after 5s
  if (session.autoRetry && (session.retryCount ?? 0) < 1) {
    const latestFailedRun = session.recentRuns.find((r) => r.outcome === 'failed');
    if (latestFailedRun && !session.activeRun) {
      const failAge = latestFailedRun.finishedAt
        ? Date.now() - new Date(latestFailedRun.finishedAt).getTime()
        : Infinity;
      // Only auto-retry if failure is recent (within 60s) to avoid retrying stale failures
      if (failAge < 60_000) {
        session.retryCount = (session.retryCount ?? 0) + 1;
        await saveOwnedSession(session);
        console.log(`[owned-codex] Auto-retrying session ${session.surfaceId} after failure (attempt ${session.retryCount})`);
        setTimeout(async () => {
          try {
            await spawnOwnedRun(session, session.latestPrompt, session.threadId ? 'resume' : 'launch');
            invalidateOwnedCodexFleetCache();
          } catch (err) {
            console.error(`[owned-codex] Auto-retry failed for ${session.surfaceId}:`, err);
          }
        }, 5_000);
      }
    }
  }

  return session;
}

function buildOwnedRuntimeSurface(session: OwnedCodexSessionRecord, running: boolean): RuntimeSurfaceSummary {
  const lifecycle = deriveLifecycle(session);
  const lastOutcomeLabel = lifecycle.lastOutcome ? ` • last ${lifecycle.lastOutcome}` : '';

  return {
    id: session.surfaceId,
    runtime: 'codex',
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: shortHome(session.repoPath),
    branch: session.branch,
    sourceLabel: running
      ? `IDE-owned Codex registry • active pid ${session.activeRun?.pid ?? 'unknown'}${lastOutcomeLabel}`
      : `IDE-owned Codex registry • ${lifecycleAvailabilityLabel(lifecycle.availability)}${lastOutcomeLabel}`,
    tailSourceLabel: `${shortHome(session.sessionDir)}/${RUNS_DIR}/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: lifecycle.availability === 'ready-for-resume',
      interrupt: lifecycle.availability === 'running',
      resize: false,
      diffContext: Boolean(session.branch || session.repoSlug),
      reviewContext: Boolean(session.branch || session.repoSlug),
    },
    lifecycle,
    reviewContext: {
      repoSlug: session.repoSlug,
      branch: session.branch,
      head: session.head,
    },
  };
}

function latestRun(session: OwnedCodexSessionRecord) {
  return [...session.recentRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function deriveOwnedStatus(session: OwnedCodexSessionRecord): AgentSummary['status'] {
  const lifecycle = deriveLifecycle(session);
  if (lifecycle.availability === 'running') return 'running';
  if (lifecycle.lastOutcome === 'failed') return 'failed';
  if (lifecycle.availability === 'awaiting-thread') return 'waiting';
  if (lifecycle.lastOutcome === 'interrupted') return 'waiting';
  if (lifecycle.availability === 'ready-for-resume') return 'reviewing';

  const latest = latestRun(session);
  if (!latest) return 'idle';
  const ageMs = Math.max(0, Date.now() - new Date(latest.finishedAt ?? latest.startedAt).getTime());
  if (ageMs < ACTIVE_WINDOW_MS) return 'reviewing';
  if (ageMs < RECENT_WINDOW_MS) return 'reviewing';
  return 'idle';
}

function buildOwnedCurrentTask(session: OwnedCodexSessionRecord, running: boolean) {
  const lifecycle = deriveLifecycle(session);
  if (running) {
    return `IDE-launched Codex run active. ${session.latestSummary}`;
  }
  if (lifecycle.availability === 'awaiting-thread') {
    return `IDE-owned Codex session launched and waiting for its first thread id. ${session.latestSummary}`;
  }
  if (reviewDisposition(session) === 'resolved') {
    return `Operator marked this owned result resolved. Keep watching only if new evidence appears. ${session.latestSummary}`;
  }
  if (lifecycle.lastOutcome === 'interrupted') {
    return `IDE-owned Codex session is ready for resume after an interrupted run. ${session.latestSummary}`;
  }
  if (lifecycle.lastOutcome === 'failed') {
    return `IDE-owned Codex session is ready for a corrective follow-up after a failed run. ${session.latestSummary}`;
  }
  if (session.threadId) {
    return `IDE-owned Codex session ready for the next input via resume. ${session.latestSummary}`;
  }
  return `IDE-owned Codex session is idle. ${session.latestSummary}`;
}

async function listOwnedSessionDirs() {
  const root = await ensureOwnedRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

async function spawnOwnedRun(session: OwnedCodexSessionRecord, prompt: string, mode: OwnedRunMode) {
  await ensureDir(path.join(session.sessionDir, RUNS_DIR));

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stdoutPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.jsonl`);
  const stderrPath = path.join(session.sessionDir, RUNS_DIR, `${runId}.stderr.log`);

  const args = mode === 'launch'
    ? runArgsForLaunch(session.repoPath, prompt)
    : runArgsForResume(session.threadId ?? '', prompt);

  let pid = 0;
  let tmuxName: string | undefined;

  // Try tmux-wrapped launch first
  if (await isTmuxAvailable()) {
    tmuxName = tmuxSessionName('codex', runId);
    // Use shell command with tee to preserve JSON stdout capture
    const codexCmd = ['codex', ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const shellCmd = `${codexCmd} | tee '${stdoutPath}' 2>'${stderrPath}'`;
    const result = await createTmuxSession(tmuxName, 'sh', ['-c', shellCmd], session.repoPath);
    if (result.ok) {
      // tmux doesn't give us a direct PID, use 0
      pid = 0;
    } else {
      tmuxName = undefined; // fall through to detached spawn
    }
  }

  if (!tmuxName) {
    // Fallback: detached spawn (existing behavior)
    const stdoutFd = openSync(stdoutPath, 'a');
    const stderrFd = openSync(stderrPath, 'a');
    try {
      const child = spawn('codex', args, {
        cwd: session.repoPath,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });
      child.unref();
      pid = child.pid ?? 0;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }

  const run: OwnedCodexRunRecord = {
    id: runId,
    mode,
    prompt,
    startedAt: nowIso(),
    pid,
    stdoutPath,
    stderrPath,
    outcome: 'running',
    tmuxSession: tmuxName,
  };

  session.latestPrompt = prompt;
  session.latestSummary = compactText(prompt, 140) || session.latestSummary;
  session.reviewDisposition = 'watching';
  session.reviewDispositionUpdatedAt = nowIso();
  session.activeRun = run;
  session.recentRuns = [run, ...session.recentRuns].slice(0, 16);
  await saveOwnedSession(session);
  return run;
}

export async function launchOwnedCodexSession(request: OwnedCodexLaunchRequest): Promise<OwnedCodexLaunchResponse> {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const repoPath = await validateWorkspace(request.cwd);
  const repo = await resolveRepoContext(repoPath);
  const id = `codex-owned-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(await ensureOwnedRoot(), id);
  await ensureDir(sessionDir);

  const session: OwnedCodexSessionRecord = {
    surfaceId: `codex-owned:${id}`,
    sessionDir,
    cwd: repoPath,
    repoPath,
    repoSlug: repo.repoSlug,
    branch: repo.branch,
    head: repo.head,
    title: repo.title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    latestPrompt: prompt,
    latestSummary: compactText(prompt, 140) || 'Owned Codex session launched from Cortex IDE.',
    reviewDisposition: 'watching',
    reviewDispositionUpdatedAt: nowIso(),
    recentRuns: [],
  };

  await saveOwnedSession(session);
  await spawnOwnedRun(session, prompt, 'launch');
  invalidateOwnedCodexFleetCache();

  return {
    ok: true,
    runtime: 'codex',
    surfaceId: session.surfaceId,
    note: `Owned Codex run launched for ${repo.title}. It will become mutable through resume/interrupt only because Cortex IDE owns this surface.`,
  };
}

export async function continueOwnedCodexSession(surfaceId: string, prompt: string) {
  const session = await findOwnedSession(surfaceId);
  if (!session) {
    throw new Error('Owned Codex session was not found.');
  }
  await refreshOwnedSession(session);

  if (session.activeRun && isPidAlive(session.activeRun.pid)) {
    throw new Error('This owned Codex session still has an active run. Wait for it to settle or interrupt it first.');
  }
  if (!session.threadId) {
    throw new Error('This owned Codex session does not have a thread id yet, so resume is not available.');
  }

  await spawnOwnedRun(session, prompt.trim(), 'resume');
  invalidateOwnedCodexFleetCache();
  return {
    ok: true,
    note: 'Queued a new turn on the IDE-owned Codex session via codex exec resume.',
  };
}

export async function interruptOwnedCodexSession(surfaceId: string) {
  const session = await findOwnedSession(surfaceId);
  if (!session) {
    throw new Error('Owned Codex session was not found.');
  }
  await refreshOwnedSession(session);

  if (!session.activeRun || !isPidAlive(session.activeRun.pid)) {
    return { interrupted: false, note: 'No active owned Codex run was in flight.' };
  }

  try {
    process.kill(-session.activeRun.pid, 'SIGINT');
    session.activeRun = {
      ...session.activeRun,
      outcome: 'interrupted',
      interruptRequestedAt: nowIso(),
    };
    session.recentRuns = session.recentRuns.map((run) =>
      run.id === session.activeRun?.id
        ? {
            ...run,
            outcome: 'interrupted',
            interruptRequestedAt: session.activeRun?.interruptRequestedAt,
          }
        : run,
    );
    await saveOwnedSession(session);
    invalidateOwnedCodexFleetCache();
    return { interrupted: true, note: 'Interrupt sent to the active IDE-owned Codex run.' };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unable to interrupt the owned Codex run.');
  }
}

export async function setOwnedCodexReviewDisposition(surfaceId: string, disposition: OwnedReviewDisposition) {
  const session = await findOwnedSession(surfaceId);
  if (!session) {
    throw new Error('Owned Codex session was not found.');
  }

  session.reviewDisposition = disposition;
  session.reviewDispositionUpdatedAt = nowIso();
  await saveOwnedSession(session);
  invalidateOwnedCodexFleetCache();

  return {
    disposition,
    note: disposition === 'resolved'
      ? 'Marked this owned result resolved. It stays visible, but no longer needs active attention unless new evidence appears.'
      : 'Switched this owned result back to keep-watching mode.',
  };
}

async function findOwnedSession(surfaceId: string) {
  for (const sessionDir of await listOwnedSessionDirs()) {
    const filePath = metadataPath(sessionDir);
    if (!(await pathExists(filePath))) continue;
    const session = await loadOwnedSession(sessionDir);
    if (session.surfaceId === surfaceId) {
      return session;
    }
  }
  return null;
}

async function collectOwnedTailEntries(session: OwnedCodexSessionRecord) {
  const runs = [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const entries: OwnedTailEntry[] = [];
  const groups: OwnedTailGroup[] = [];
  let discoveredThreadId = session.threadId;

  for (const run of runs) {
    const { parsed, stderrRaw } = await readRunArtifacts(run);
    if (!parsed.entries.length) continue;

    const outcome = deriveRunOutcome(run, parsed, stderrRaw);
    discoveredThreadId = discoveredThreadId ?? parsed.threadId;
    entries.push(...parsed.entries);
    groups.push({
      id: run.id,
      title: `${run.mode === 'launch' ? 'Launch turn' : 'Resume turn'} • ${outcome}`,
      mode: run.mode,
      outcome,
      prompt: compactText(run.prompt, 260),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startedAtLabel: formatClock(run.startedAt),
      finishedAtLabel: formatClock(run.finishedAt),
      summary: outcome === 'interrupted'
        ? 'Interrupted before Codex completed the turn.'
        : outcome === 'failed'
          ? 'Run ended without a clean turn completion.'
          : outcome === 'running'
            ? 'Run is still in flight.'
            : 'Run completed and the session can continue from here.',
      entries: parsed.entries,
    });
  }

  return {
    entries: entries.slice(-24),
    groups: groups.slice(-8),
    threadId: discoveredThreadId,
  };
}

function buildReviewActions(packet: Pick<RuntimeReviewPacket, 'dirty' | 'changedFiles' | 'lastRun' | 'reviewDisposition'>) {
  const actions = [] as string[];

  if (packet.lastRun?.outcome === 'running') {
    actions.push('Watch the active run', 'Interrupt if it drifts');
    return actions;
  }

  if (packet.reviewDisposition === 'resolved') {
    actions.push('Keep watching for new evidence');
  }

  if (packet.dirty) {
    actions.push('Review current repo delta', 'Open desktop diff context');
  }

  if (packet.lastRun?.outcome === 'failed') {
    actions.push('Resume with correction context', 'Inspect failing command evidence');
  } else if (packet.lastRun?.outcome === 'interrupted') {
    actions.push('Resume from the interrupted state');
  } else if (packet.lastRun?.outcome === 'finished') {
    actions.push('Decide whether the result is good enough', 'Resume with a bounded follow-up if needed');
  }

  if (!actions.length) {
    actions.push('Review the latest run evidence');
  }

  return actions.slice(0, 4);
}

function buildReviewNotes(session: OwnedCodexSessionRecord, dirty: boolean) {
  const notes = [
    'Current repo delta is shown live from git and is not yet isolated per run when multiple sessions touch the same repo.',
  ];

  if (!dirty) {
    notes.push('The repo is currently clean, so this run may have been exploratory, purely read-only, or already reconciled.');
  }

  if (!session.threadId) {
    notes.push('This owned surface is still waiting for its first persistent thread id before resume becomes available.');
  }

  return notes;
}

function reviewDisposition(session: OwnedCodexSessionRecord): OwnedReviewDisposition {
  return session.reviewDisposition ?? 'watching';
}

export async function getOwnedCodexRuntimeTail(surfaceId: string) {
  const session = await findOwnedSession(surfaceId);
  if (!session) {
    throw new Error('Owned Codex runtime surface was not found.');
  }

  await refreshOwnedSession(session);
  const tail = await collectOwnedTailEntries(session);
  if (!session.threadId && tail.threadId) {
    session.threadId = tail.threadId;
    await saveOwnedSession(session);
  }

  return {
    surface: buildOwnedRuntimeSurface(session, Boolean(session.activeRun && isPidAlive(session.activeRun.pid))),
    entries: tail.entries,
    groups: tail.groups,
  };
}

export async function getOwnedCodexReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket> {
  const session = await findOwnedSession(surfaceId);
  if (!session) {
    throw new Error('Owned Codex review packet was not found.');
  }

  await refreshOwnedSession(session);
  const repoReview = await getRuntimeRepoReview(session.repoPath);
  const lastRun = latestRun(session);
  const lastRunArtifacts = lastRun ? await readRunArtifacts(lastRun) : null;
  const lastRunOutcome = lastRun && lastRunArtifacts
    ? deriveRunOutcome(lastRun, lastRunArtifacts.parsed, lastRunArtifacts.stderrRaw)
    : undefined;
  const lastRunEvidence = lastRunArtifacts && lastRun
    ? parseOwnedRunEvidence(lastRunArtifacts.stdoutRaw, lastRun, lastRunOutcome)
    : null;
  const runtimeSurface = buildOwnedRuntimeSurface(session, Boolean(session.activeRun && isPidAlive(session.activeRun.pid)));
  const linkedWorktree = await getWorktreeManager(session.repoPath).list()
    .then((worktrees) => worktrees.find((worktree) => worktree.sessionKey === session.surfaceId) ?? null)
    .catch(() => null);

  const packet: RuntimeReviewPacket = {
    surfaceId: session.surfaceId,
    runtime: 'codex',
    title: session.title,
    summary: runtimeSurface.lifecycle?.summary ?? session.latestSummary,
    repoPath: shortHome(session.repoPath),
    repoSlug: session.repoSlug,
    branch: repoReview.branch ?? session.branch,
    head: repoReview.head ?? session.head,
    dirty: repoReview.dirty,
    diffStat: repoReview.diffStat,
    changedFiles: repoReview.changedFiles,
    recentCommits: repoReview.recentCommits,
    reviewDisposition: reviewDisposition(session),
    reviewDispositionUpdatedAt: session.reviewDispositionUpdatedAt,
    reviewDispositionUpdatedAtLabel: formatClock(session.reviewDispositionUpdatedAt),
    worktree: linkedWorktree ? {
      id: linkedWorktree.id,
      path: linkedWorktree.path,
      branch: linkedWorktree.branch,
      baseBranch: linkedWorktree.baseBranch,
      status: linkedWorktree.status,
      dirtyFiles: linkedWorktree.dirtyFiles,
    } : null,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          mode: lastRun.mode,
          outcome: lastRunOutcome ?? lastRun.outcome,
          prompt: compactText(lastRun.prompt, 260),
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          startedAtLabel: formatClock(lastRun.startedAt),
          finishedAtLabel: formatClock(lastRun.finishedAt),
          assistantSummary: lastRunEvidence?.assistantSummary,
          commands: lastRunEvidence?.commands ?? [],
        }
      : undefined,
    nextActions: [],
    notes: buildReviewNotes(session, repoReview.dirty),
  };

  packet.nextActions = buildReviewActions(packet);
  return packet;
}

export async function getOwnedCodexFleetAdditions(
  options: { fresh?: boolean } = {},
): Promise<OwnedCodexFleetAdditions> {
  const fresh = options.fresh ?? false;
  const now = Date.now();
  const generation = ownedFleetGeneration;
  if (!fresh && ownedFleetCache && (now - ownedFleetCache.cachedAt) < OWNED_CODEX_FLEET_TTL_MS) {
    return ownedFleetCache.value;
  }

  if (!fresh && ownedFleetInflight) {
    return ownedFleetInflight;
  }

  const promise = (async () => {
  const sessionDirs = await listOwnedSessionDirs();
  if (!sessionDirs.length) {
    return {
      agents: [],
      squads: [],
      events: [],
      artifacts: [],
      ownedThreadIds: [],
    };
  }

  const sessions = [] as OwnedCodexSessionRecord[];
  for (const sessionDir of sessionDirs) {
    const filePath = metadataPath(sessionDir);
    if (!(await pathExists(filePath))) continue;
    const session = await loadOwnedSession(sessionDir);
    await refreshOwnedSession(session);
    sessions.push(session);
  }

  const agents: AgentSummary[] = sessions
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((session) => {
      const running = Boolean(session.activeRun && isPidAlive(session.activeRun.pid));
      const status = deriveOwnedStatus(session);
      const runtimeSurface = buildOwnedRuntimeSurface(session, running);
      const lifecycle = runtimeSurface.lifecycle;
      const lastRun = latestRun(session);
      const lifecycleLabel = lifecycle?.availability === 'running'
        ? 'owned active'
        : lifecycle?.lastOutcome === 'failed'
          ? 'owned failed'
          : lifecycle?.lastOutcome === 'interrupted'
            ? 'owned interrupted'
            : lifecycle?.availability === 'awaiting-thread'
              ? 'owned warming'
              : 'owned ready';
      return {
        id: session.surfaceId,
        name: session.title,
        squadId: 'squad-codex-owned',
        runtime: 'codex',
        model: 'codex owned',
        status,
        currentTask: buildOwnedCurrentTask(session, running),
        workspace: shortHome(session.repoPath),
        branch: session.branch ?? 'detached',
        sessionKey: session.surfaceId,
        approvalStatus: 'none',
        lastEventAt: relativeAge(lastRun?.finishedAt ?? lastRun?.startedAt ?? session.createdAt),
        context: {
          usedPercent: 0,
          trend: running ? 'rising' : 'stable',
        },
        alerts: lifecycle?.lastOutcome === 'failed' ? 1 : 0,
        sessionId: session.threadId ?? session.surfaceId,
        sessionKind: 'owned-runtime',
        surfaceLabel: `Codex terminal • ${lifecycleLabel}`,
        runtimeSurface,
        tmuxSession: session.activeRun?.tmuxSession ?? lastRun?.tmuxSession,
      } satisfies AgentSummary;
    });

  const squad: SquadSummary | null = agents.length
    ? {
        id: 'squad-codex-owned',
        name: 'Codex Owned',
        status: agents.some((agent) => agent.status === 'running') ? 'healthy' : 'watching',
        throughputLabel: `${agents.length} IDE-owned surface${agents.length === 1 ? '' : 's'}`,
        blockers: 0,
        alerts: 0,
        liveSessions: agents.length,
        members: agents.map((agent) => agent.id),
      }
    : null;

  const events: EventItem[] = agents.slice(0, 4).map((agent) => ({
    id: `evt-${agent.id}`,
    agentId: agent.id,
    squadId: agent.squadId,
    severity: agent.status === 'running' ? 'info' : agent.status === 'failed' ? 'critical' : agent.status === 'waiting' ? 'warning' : 'success',
    title: `${agent.name} • ${agent.surfaceLabel}`,
    detail: `${agent.currentTask}${agent.runtimeSurface?.lifecycle?.lastOutcome ? ` • last ${agent.runtimeSurface.lifecycle.lastOutcome}` : ''}${agent.runtimeSurface?.reviewContext?.repoSlug ? ` • ${agent.runtimeSurface.reviewContext.repoSlug}` : ''}`,
    timestamp: agent.lastEventAt,
  }));

  const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
    kind: 'run_log',
    title: `${agent.name} owned tail`,
    state: agent.runtimeSurface?.lifecycle?.lastOutcome === 'failed' ? 'new' : 'reviewing',
    agentId: agent.id,
    detail: agent.runtimeSurface?.lifecycle?.lastOutcome
      ? `Readable JSON tail recovered from an IDE-owned Codex exec/resume run. Last outcome: ${agent.runtimeSurface.lifecycle.lastOutcome}.`
      : 'Readable JSON tail recovered from an IDE-owned Codex exec/resume run.',
  }));

  return {
    agents,
    squads: squad ? [squad] : [],
    events,
    artifacts,
    sourceLabel: 'Owned Codex launch registry',
    note: agents.length
      ? 'IDE-owned Codex surfaces can now launch, resume between runs, and interrupt active runs. Discovered Codex terminals remain watch-only.'
      : undefined,
    ownedThreadIds: agents.map((agent) => agent.sessionId ?? '').filter((value) => value && !value.startsWith('codex-owned:')),
  };
  })();

  ownedFleetInflight = promise;
  return promise.finally(() => {
    if (ownedFleetInflight === promise) {
      ownedFleetInflight = null;
    }
  }).then((value) => {
    if (generation === ownedFleetGeneration) {
      ownedFleetCache = { value, cachedAt: Date.now() };
    }
    return value;
  });
}
