import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { AgentSummary, EventItem, ReviewArtifact, RuntimeSurfaceSummary, SquadSummary } from '@/lib/fleet/types';

const execFileAsync = promisify(execFile);
const OWNED_CODEX_ROOT = process.env.CORTEX_IDE_OWNED_CODEX_ROOT || path.join(os.homedir(), '.cortex-ide', 'owned-codex');
const RUNS_DIR = 'runs';
const METADATA_FILE = 'session.json';
const ACTIVE_WINDOW_MS = 10 * 60_000;
const RECENT_WINDOW_MS = 6 * 60 * 60_000;

type OwnedRunMode = 'launch' | 'resume';

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
};

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
  activeRun?: OwnedCodexRunRecord;
  recentRuns: OwnedCodexRunRecord[];
};

type OwnedTailEntry = {
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  label: string;
  text: string;
  timestampLabel?: string;
};

type ParsedRunLog = {
  threadId?: string;
  entries: OwnedTailEntry[];
};

function nowIso() {
  return new Date().toISOString();
}

function compactText(value: string | null | undefined, max = 120) {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
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
  const resolved = path.resolve(targetCwd);
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
      }

      if (type === 'turn.completed') {
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

  return { threadId, entries };
}

async function refreshOwnedSession(session: OwnedCodexSessionRecord) {
  let dirty = false;
  const activeRun = session.activeRun;

  if (activeRun && !isPidAlive(activeRun.pid)) {
    const finishedAt = nowIso();
    session.activeRun = undefined;
    session.recentRuns = session.recentRuns.map((run) =>
      run.id === activeRun.id && !run.finishedAt
        ? {
            ...run,
            finishedAt,
          }
        : run,
    );
    dirty = true;
  }

  for (const run of session.recentRuns) {
    const stdoutExists = await pathExists(run.stdoutPath);
    if (!stdoutExists) continue;
    const raw = await readFile(run.stdoutPath, 'utf8').catch(() => '');
    const parsed = parseOwnedRunLog(raw, run);
    if (!session.threadId && parsed.threadId) {
      session.threadId = parsed.threadId;
      dirty = true;
    }
    if (!run.finishedAt && session.activeRun?.id !== run.id && raw.includes('"turn.completed"')) {
      run.finishedAt = nowIso();
      dirty = true;
    }
  }

  if (dirty) {
    await saveOwnedSession(session);
  }

  return session;
}

function buildOwnedRuntimeSurface(session: OwnedCodexSessionRecord, running: boolean): RuntimeSurfaceSummary {
  return {
    id: session.surfaceId,
    runtime: 'codex',
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: shortHome(session.repoPath),
    branch: session.branch,
    sourceLabel: running
      ? `IDE-owned Codex registry • active pid ${session.activeRun?.pid ?? 'unknown'}`
      : session.threadId
        ? 'IDE-owned Codex registry • ready for resume'
        : 'IDE-owned Codex registry • awaiting thread id',
    tailSourceLabel: `${shortHome(session.sessionDir)}/${RUNS_DIR}/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: !running && Boolean(session.threadId),
      interrupt: running,
      resize: false,
      diffContext: Boolean(session.branch || session.repoSlug),
      reviewContext: Boolean(session.branch || session.repoSlug),
    },
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
  if (session.activeRun && isPidAlive(session.activeRun.pid)) return 'running';
  const latest = latestRun(session);
  if (!latest) return 'idle';
  const ageMs = Math.max(0, Date.now() - new Date(latest.finishedAt ?? latest.startedAt).getTime());
  if (ageMs < ACTIVE_WINDOW_MS) return 'reviewing';
  if (ageMs < RECENT_WINDOW_MS) return 'reviewing';
  return 'idle';
}

function buildOwnedCurrentTask(session: OwnedCodexSessionRecord, running: boolean) {
  if (running) {
    return `IDE-launched Codex run active. ${session.latestSummary}`;
  }
  if (session.threadId) {
    return `IDE-owned Codex session ready for the next input via resume. ${session.latestSummary}`;
  }
  return `IDE-owned Codex session launched and waiting for its first thread id. ${session.latestSummary}`;
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
  const stdoutFd = openSync(stdoutPath, 'a');
  const stderrFd = openSync(stderrPath, 'a');

  try {
    const args = mode === 'launch'
      ? runArgsForLaunch(session.repoPath, prompt)
      : runArgsForResume(session.threadId ?? '', prompt);

    const child = spawn('codex', args, {
      cwd: session.repoPath,
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });

    child.unref();

    const run: OwnedCodexRunRecord = {
      id: runId,
      mode,
      prompt,
      startedAt: nowIso(),
      pid: child.pid ?? 0,
      stdoutPath,
      stderrPath,
    };

    session.latestPrompt = prompt;
    session.latestSummary = compactText(prompt, 140) || session.latestSummary;
    session.activeRun = run;
    session.recentRuns = [run, ...session.recentRuns].slice(0, 16);
    await saveOwnedSession(session);
    return run;
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
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
    recentRuns: [],
  };

  await saveOwnedSession(session);
  await spawnOwnedRun(session, prompt, 'launch');

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
    return { interrupted: true, note: 'Interrupt sent to the active IDE-owned Codex run.' };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unable to interrupt the owned Codex run.');
  }
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
  let discoveredThreadId = session.threadId;

  for (const run of runs) {
    if (!(await pathExists(run.stdoutPath))) continue;
    const raw = await readFile(run.stdoutPath, 'utf8').catch(() => '');
    const parsed = parseOwnedRunLog(raw, run);
    discoveredThreadId = discoveredThreadId ?? parsed.threadId;
    entries.push(...parsed.entries);
  }

  return {
    entries: entries.slice(-24),
    threadId: discoveredThreadId,
  };
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
  };
}

export async function getOwnedCodexFleetAdditions(): Promise<{
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
  ownedThreadIds: string[];
}> {
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
      const lastRun = latestRun(session);
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
        alerts: 0,
        sessionId: session.threadId ?? session.surfaceId,
        sessionKind: 'owned-runtime',
        surfaceLabel: running ? 'Codex terminal • owned active' : 'Codex terminal • owned',
        runtimeSurface,
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
    severity: agent.status === 'running' ? 'info' : 'success',
    title: `${agent.name} • ${agent.surfaceLabel}`,
    detail: `${agent.currentTask}${agent.runtimeSurface?.reviewContext?.repoSlug ? ` • ${agent.runtimeSurface.reviewContext.repoSlug}` : ''}`,
    timestamp: agent.lastEventAt,
  }));

  const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
    kind: 'run_log',
    title: `${agent.name} owned tail`,
    state: 'reviewing',
    agentId: agent.id,
    detail: 'Readable JSON tail recovered from an IDE-owned Codex exec/resume run.',
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
}
