import { execFile } from 'node:child_process';
import { access, open, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';
import { MODEL_IDS } from '@/lib/models';
import { truncateText } from '@/lib/util/text';

const execFileAsync = promisify(execFile);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const CODEX_SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const CODEX_SHELL_SNAPSHOTS_ROOT = path.join(CODEX_HOME, 'shell_snapshots');
const CODEX_SOURCE_LABEL = 'Local Codex discovery';
const RECENT_WINDOW_MS = 6 * 60 * 60_000;
const DISCOVERED_STALE_WINDOW_MS = 24 * 60 * 60_000;
const CODEX_DISCOVERED_FLEET_TTL_MS = 15_000;

type CodexThreadRow = {
  id: string;
  title: string;
  cwd: string;
  updated_at: number;
  rollout_path: string;
  git_branch?: string | null;
  git_sha?: string | null;
  git_origin_url?: string | null;
  first_user_message?: string | null;
  model?: string | null;
};

type CodexProcessBinding = {
  thread_id: string;
  process_uuid: string;
  last_ts: number;
};

type LiveCodexProcess = {
  pid: number;
  parentPid?: number;
  tty?: string;
  elapsed?: string;
  command?: string;
  cwd?: string;
  termSessionId?: string;
};

type CodexThreadActivity = {
  lastLogTs?: number;
  pid?: number;
  tty?: string;
  active: boolean;
};

type CodexDiscoveredFleetAdditions = {
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
};

let discoveredFleetCache: { value: CodexDiscoveredFleetAdditions; cachedAt: number } | null = null;
let discoveredFleetInflight: Promise<CodexDiscoveredFleetAdditions> | null = null;
let discoveredFleetGeneration = 0;

export function invalidateCodexDiscoveredFleetCache() {
  discoveredFleetGeneration += 1;
  discoveredFleetCache = null;
  discoveredFleetInflight = null;
}

export type RuntimeTailEntry = {
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  role?: 'user' | 'assistant' | 'system';
  label: string;
  text: string;
  timestamp?: string;
  timestampLabel?: string;
  thinking?: string;
  tokens?: {
    input: number;
    output: number;
  };
};

function compactText(value: string | null | undefined, max = 120) {
  return truncateText(value, max, { normalizeWhitespace: true });
}

function compactTitle(value: string | null | undefined, max = 72) {
  const firstParagraph = (value ?? '').split(/\n\n/)[0] ?? '';
  return compactText(firstParagraph, max) || 'Codex session';
}

function shortenPath(filePath?: string | null) {
  if (!filePath) return 'unknown';
  return filePath.replace(`${os.homedir()}/`, '~/');
}

function normalizeFsPath(value?: string | null) {
  if (!value) return '';
  return path.resolve(value).replace(/\/+$/, '');
}

function relativeAgeFromSeconds(unixSeconds: number) {
  const ageMs = Math.max(0, Date.now() - unixSeconds * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

function repoSlugFromOrigin(value?: string | null) {
  const normalized = (value ?? '').trim();
  if (!normalized) return undefined;

  const httpsMatch = normalized.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshMatch = normalized.match(/github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  return undefined;
}

function repoNameFromThread(thread: CodexThreadRow) {
  const localName = path.basename(thread.cwd);
  if (localName) {
    return localName;
  }

  const repoSlug = repoSlugFromOrigin(thread.git_origin_url);
  if (repoSlug) {
    return repoSlug.split('/').pop() ?? repoSlug;
  }

  return 'codex';
}

function branchLabel(branch?: string | null) {
  const compact = compactText(branch, 36);
  return compact || undefined;
}

function surfaceDisplayTitle(thread: CodexThreadRow) {
  const repoName = repoNameFromThread(thread);
  const branch = branchLabel(thread.git_branch);
  return branch ? `${repoName} • ${branch}` : repoName;
}

function taskSummary(thread: CodexThreadRow) {
  return compactTitle(thread.first_user_message || thread.title, 120);
}

function parsePidFromProcessUuid(processUuid?: string | null) {
  const match = (processUuid ?? '').match(/^pid:(\d+):/);
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}

async function codexStateExists() {
  try {
    await access(CODEX_STATE_DB);
    return true;
  } catch {
    return false;
  }
}

export async function queryCodexThreads(limit = 6) {
  if (!(await codexStateExists())) {
    return [] as CodexThreadRow[];
  }

  const query = [
    'select',
    'id,',
    'title,',
    'cwd,',
    'updated_at,',
    'rollout_path,',
    "coalesce(git_branch, '') as git_branch,",
    "coalesce(git_sha, '') as git_sha,",
    "coalesce(git_origin_url, '') as git_origin_url,",
    "coalesce(first_user_message, '') as first_user_message,",
    "coalesce(model, '') as model",
    'from threads',
    'where archived = 0',
    'order by updated_at desc',
    `limit ${limit};`,
  ].join(' ');

  const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], { windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout || '[]') as CodexThreadRow[];
  return parsed.filter((row) => row.id && row.rollout_path && row.cwd);
}

export async function queryCodexThreadById(threadId: string) {
  if (!(await codexStateExists()) || !threadId) {
    return null;
  }

  const escapedThreadId = threadId.replace(/'/g, "''");
  const query = [
    'select',
    'id,',
    'title,',
    'cwd,',
    'updated_at,',
    'rollout_path,',
    "coalesce(git_branch, '') as git_branch,",
    "coalesce(git_sha, '') as git_sha,",
    "coalesce(git_origin_url, '') as git_origin_url,",
    "coalesce(first_user_message, '') as first_user_message,",
    "coalesce(model, '') as model",
    'from threads',
    `where archived = 0 and id = '${escapedThreadId}'`,
    'limit 1;',
  ].join(' ');

  const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], { windowsHide: true,
    maxBuffer: 512 * 1024,
  });

  const [thread] = JSON.parse(stdout || '[]') as CodexThreadRow[];
  return thread?.id && thread.rollout_path && thread.cwd ? thread : null;
}

async function queryProcessBindings() {
  if (!(await codexStateExists())) {
    return [] as CodexProcessBinding[];
  }

  const query = [
    'select',
    'thread_id,',
    'process_uuid,',
    'max(ts) as last_ts',
    'from logs',
    'where thread_id is not null and process_uuid is not null',
    'group by thread_id, process_uuid',
    'order by last_ts desc;',
  ].join(' ');

  const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], { windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  return JSON.parse(stdout || '[]') as CodexProcessBinding[];
}

async function readProcessCwd(pid: number) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const cwdLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'));
    return cwdLine ? cwdLine.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

async function readProcessTermSessionId(pid: number) {
  try {
    const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], { windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    const match = stdout.match(/(?:^|\s)TERM_SESSION_ID=([^\s]+)/);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function queryLiveCodexProcesses(pids: number[]) {
  if (!pids.length) {
    return new Map<number, LiveCodexProcess>();
  }

  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'pid=', '-o', 'ppid=', '-o', 'tt=', '-o', 'etime=', '-o', 'command=', '-p', pids.join(',')],
      { windowsHide: true,
        maxBuffer: 512 * 1024,
      },
    );

    const rows: LiveCodexProcess[] = [];
    for (const line of stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isFinite(pid)) continue;
      const row: LiveCodexProcess = {
        pid,
        parentPid: Number(match[2]),
        tty: match[3],
        elapsed: match[4],
        command: match[5],
      };
      if (!row.command?.includes('/codex')) continue;
      rows.push(row);
    }

    const result = new Map<number, LiveCodexProcess>();
    await Promise.all(
      rows.map(async (row) => {
        result.set(row.pid, {
          ...row,
          cwd: await readProcessCwd(row.pid),
          termSessionId: await readProcessTermSessionId(row.pid),
        });
      }),
    );
    return result;
  } catch {
    return new Map<number, LiveCodexProcess>();
  }
}

async function buildShellSnapshotSessionMap(threadIds: string[]) {
  if (!threadIds.length) {
    return new Map<string, string>();
  }

  let snapshotFiles: string[];
  try {
    snapshotFiles = await readdir(CODEX_SHELL_SNAPSHOTS_ROOT);
  } catch {
    return new Map<string, string>();
  }

  const wanted = new Set(threadIds);
  const mapping = new Map<string, string>();

  for (const fileName of snapshotFiles) {
    const [threadId] = fileName.split('.');
    if (!threadId || !wanted.has(threadId) || mapping.has(threadId)) continue;
    const filePath = path.join(CODEX_SHELL_SNAPSHOTS_ROOT, fileName);
    try {
      const raw = await readFile(filePath, 'utf8');
      const match = raw.match(/^export TERM_SESSION_ID=(.+)$/m);
      if (match?.[1]) {
        mapping.set(threadId, match[1].trim());
      }
    } catch {
      continue;
    }
  }

  return mapping;
}

async function queryAllLiveCodexProcesses() {
  try {
    const { stdout: psOut } = await execFileAsync(
      'bash',
      ['-c', 'ps -eo pid=,command= | grep codex | grep -v grep'],
      { windowsHide: true, maxBuffer: 256 * 1024 },
    );

    const allPids: number[] = [];
    for (const line of psOut.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const pidMatch = line.match(/^(\d+)/);
      if (!pidMatch?.[1]) continue;
      const pid = Number(pidMatch[1]);
      if (Number.isFinite(pid) && line.includes('/codex')) {
        allPids.push(pid);
      }
    }

    const allLive = await queryLiveCodexProcesses(allPids);
    const pidSet = new Set(allLive.keys());

    return new Map(
      [...allLive.entries()].filter(([, proc]) => !proc.parentPid || !pidSet.has(proc.parentPid)),
    );
  } catch {
    return new Map<number, LiveCodexProcess>();
  }
}

function classifyActivity(thread: CodexThreadRow, activity?: CodexThreadActivity) {
  if (activity?.active) {
    return 'active' as const;
  }

  const updatedAgeMs = Math.max(0, Date.now() - thread.updated_at * 1000);
  const lastLogAgeMs = activity?.lastLogTs ? Math.max(0, Date.now() - activity.lastLogTs * 1000) : Infinity;

  if (Math.min(updatedAgeMs, lastLogAgeMs) < RECENT_WINDOW_MS) {
    return 'recent' as const;
  }

  return 'stale' as const;
}

function shouldExposeDiscoveredThread(thread: CodexThreadRow, activity?: CodexThreadActivity) {
  if (activity?.active) return true;
  const freshestActivityMs = Math.max(
    thread.updated_at * 1000,
    (activity?.lastLogTs ?? 0) * 1000,
  );
  return (Date.now() - freshestActivityMs) <= DISCOVERED_STALE_WINDOW_MS;
}

function deriveStatus(thread: CodexThreadRow, activity?: CodexThreadActivity): AgentSummary['status'] {
  const activityState = classifyActivity(thread, activity);
  if (activityState === 'active') return 'running';
  if (activityState === 'recent') return 'reviewing';
  return 'idle';
}

function buildRuntimeSurface(thread: CodexThreadRow, activity?: CodexThreadActivity): RuntimeSurfaceSummary {
  const repoSlug = repoSlugFromOrigin(thread.git_origin_url);
  const activityState = classifyActivity(thread, activity);
  const isLive = activityState === 'active';
  // Non-live discovered sessions can still be resumed: `codex exec resume
  // <threadId> <message>` spawns a fresh subprocess that picks up the
  // persisted thread state. We accept that pathway as valid input; the
  // adapter (src/lib/runtimes/codex.ts resume) routes closed sessions
  // through `codex exec resume`, live ones through the owned pipeline.
  const canSendInput = Boolean(thread.id);
  const activeProcessLabel = activity?.active
    ? `Local Codex discovery • live pid ${activity.pid}${activity.tty ? ` • ${activity.tty}` : ''}`
    : activityState === 'recent'
      ? 'Local Codex discovery • recent session history'
      : 'Local Codex discovery • persisted session history';

  return {
    id: `codex:${thread.id}`,
    runtime: 'codex',
    kind: 'terminal-session',
    ownership: 'discovered',
    title: surfaceDisplayTitle(thread),
    cwd: shortenPath(thread.cwd),
    branch: thread.git_branch || undefined,
    sourceLabel: activeProcessLabel,
    tailSourceLabel: '~/.codex/sessions/*.jsonl + state_5.sqlite',
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: canSendInput,
      interrupt: isLive,
      resize: false,
      diffContext: Boolean(thread.git_branch || repoSlug),
      reviewContext: Boolean(thread.git_branch || repoSlug),
    },
    reviewContext: {
      repoSlug,
      branch: thread.git_branch || undefined,
      head: thread.git_sha || undefined,
    },
  };
}

function buildCurrentTask(thread: CodexThreadRow, activity?: CodexThreadActivity) {
  const summary = taskSummary(thread);
  const activityState = classifyActivity(thread, activity);

  if (activityState === 'active') {
    return `Live Codex terminal verified via pid/log mapping${activity?.tty ? ` on ${activity.tty}` : ''}. ${summary}`;
  }

  if (activityState === 'recent') {
    return `Recent Codex session recovered from local runtime history. ${summary}`;
  }

  return `Historical Codex session recovered from local runtime history. ${summary}`;
}

async function buildActivityMap(threads: CodexThreadRow[]) {
  const byThreadId = new Map<string, CodexThreadActivity>();
  const threadIds = new Set(threads.map((thread) => thread.id));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const bindings = await queryProcessBindings();
  const threadSessionIds = await buildShellSnapshotSessionMap(threads.map((thread) => thread.id));
  const allLiveProcesses = await queryAllLiveCodexProcesses();

  const latestBindingByProcess = new Map<string, CodexProcessBinding>();
  for (const binding of bindings) {
    const existing = latestBindingByProcess.get(binding.process_uuid);
    if (!existing || binding.last_ts > existing.last_ts) {
      latestBindingByProcess.set(binding.process_uuid, binding);
    }

    if (threadIds.has(binding.thread_id)) {
      const previous = byThreadId.get(binding.thread_id);
      byThreadId.set(binding.thread_id, {
        ...previous,
        active: previous?.active ?? false,
        lastLogTs: Math.max(previous?.lastLogTs ?? 0, binding.last_ts),
      });
    }
  }

  const livePidBindings = [...latestBindingByProcess.values()]
    .map((binding) => ({
      binding,
      pid: parsePidFromProcessUuid(binding.process_uuid),
    }))
    .filter((item): item is { binding: CodexProcessBinding; pid: number } => Boolean(item.pid));

  const liveProcesses = await queryLiveCodexProcesses(livePidBindings.map((item) => item.pid));

  for (const { binding, pid } of livePidBindings) {
    if (!threadIds.has(binding.thread_id)) {
      continue;
    }

    const thread = threadById.get(binding.thread_id);
    const liveProcess = liveProcesses.get(pid);
    if (!thread || !liveProcess) {
      continue;
    }

    if (normalizeFsPath(liveProcess.cwd) !== normalizeFsPath(thread.cwd)) {
      continue;
    }

    const previous = byThreadId.get(binding.thread_id);
    byThreadId.set(binding.thread_id, {
      ...previous,
      active: true,
      pid,
      tty: liveProcess.tty,
      lastLogTs: Math.max(previous?.lastLogTs ?? 0, binding.last_ts),
    });
  }

  // Exact fallback: bind live processes to threads via TERM_SESSION_ID recovered from
  // Codex shell snapshots. This is truthful for local Terminal.app sessions even when
  // the sqlite process_uuid linkage is missing.
  for (const [threadId, termSessionId] of threadSessionIds) {
    if (!termSessionId) continue;
    const thread = threadById.get(threadId);
    if (!thread) continue;

    const proc = [...allLiveProcesses.values()].find((candidate) => (
      candidate.termSessionId === termSessionId
      && normalizeFsPath(candidate.cwd) === normalizeFsPath(thread.cwd)
    ));
    if (!proc) continue;

    const previous = byThreadId.get(threadId);
    byThreadId.set(threadId, {
      ...previous,
      active: true,
      pid: proc.pid,
      tty: proc.tty,
      lastLogTs: Math.max(previous?.lastLogTs ?? 0, thread.updated_at),
    });
  }

  return byThreadId;
}

function buildSyntheticLiveProcessSurface(
  pid: number,
  proc: LiveCodexProcess,
): RuntimeSurfaceSummary {
  const cwd = shortenPath(proc.cwd ?? '');
  const titleBase = path.basename(proc.cwd ?? '') || 'codex';

  return {
    id: `codex-live:${pid}`,
    runtime: 'codex',
    kind: 'terminal-session',
    ownership: 'discovered',
    title: `${titleBase}${proc.tty ? ` • ${proc.tty}` : ''}`,
    cwd,
    branch: undefined,
    sourceLabel: `Local Codex discovery • live pid ${pid}${proc.tty ? ` • ${proc.tty}` : ''} • process-only`,
    tailSourceLabel: 'live process inventory',
    capabilities: {
      attach: false,
      readTail: false,
      sendInput: false,
      interrupt: true,
      resize: false,
      diffContext: false,
      reviewContext: false,
    },
  };
}

export async function getCodexDiscoveredFleetAdditions(
  options: { fresh?: boolean } = {},
): Promise<CodexDiscoveredFleetAdditions> {
  const fresh = options.fresh ?? false;
  const now = Date.now();
  const generation = discoveredFleetGeneration;
  if (!fresh && discoveredFleetCache && (now - discoveredFleetCache.cachedAt) < CODEX_DISCOVERED_FLEET_TTL_MS) {
    return discoveredFleetCache.value;
  }

  if (!fresh && discoveredFleetInflight) {
    return discoveredFleetInflight;
  }

  const promise = (async () => {
  try {
    const threads = await queryCodexThreads(64);
    if (!threads.length) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
      };
    }

    const activityMap = await buildActivityMap(threads);
    const visibleThreads = threads.filter((thread) => shouldExposeDiscoveredThread(thread, activityMap.get(thread.id)));
    if (!visibleThreads.length) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
        sourceLabel: CODEX_SOURCE_LABEL,
        note: 'Codex discovery skipped stale local thread history with no live pid binding.',
      };
    }
    const liveProcesses = await queryAllLiveCodexProcesses();

    const agents: AgentSummary[] = visibleThreads.map((thread) => {
      const activity = activityMap.get(thread.id);
      const surface = buildRuntimeSurface(thread, activity);
      const status = deriveStatus(thread, activity);
      const branch = thread.git_branch || 'detached';
      const workspace = shortenPath(thread.cwd);
      const activityState = classifyActivity(thread, activity);

      return {
        id: `codex:${thread.id}`,
        name: surface.title,
        squadId: 'squad-codex-local',
        runtime: 'codex',
        model: thread.model || MODEL_IDS.codexDefault,
        status,
        currentTask: buildCurrentTask(thread, activity),
        workspace,
        branch,
        sessionKey: surface.id,
        approvalStatus: 'none',
        lastEventAt: relativeAgeFromSeconds(activity?.lastLogTs ?? thread.updated_at),
        context: {
          usedPercent: 0,
          trend: activityState === 'stale' ? 'falling' : 'stable',
        },
        alerts: 0,
        sessionId: thread.id,
        sessionKind: 'terminal',
        surfaceLabel: activityState === 'active' ? 'Codex terminal • active' : 'Codex terminal • recent',
        runtimeSurface: surface,
      } satisfies AgentSummary;
    });

    const matchedLivePids = new Set(
      [...activityMap.values()]
        .map((activity) => activity.pid)
        .filter((pid): pid is number => Number.isFinite(pid)),
    );
    for (const [pid, proc] of liveProcesses) {
      if (matchedLivePids.has(pid)) continue;
      const surface = buildSyntheticLiveProcessSurface(pid, proc);
      agents.push({
        id: surface.id,
        name: surface.title,
        squadId: 'squad-codex-local',
        runtime: 'codex',
        model: MODEL_IDS.codexDefault,
        status: 'running',
        currentTask: `Live Codex terminal detected${proc.tty ? ` on ${proc.tty}` : ''}. Durable thread binding has not been recovered yet, so transcript/resume stay disabled.`,
        workspace: surface.cwd ?? shortenPath(proc.cwd ?? ''),
        branch: 'detached',
        sessionKey: surface.id,
        approvalStatus: 'none',
        lastEventAt: 'just now',
        context: {
          usedPercent: 0,
          trend: 'stable',
        },
        alerts: 0,
        sessionId: `live:${pid}`,
        sessionKind: 'terminal',
        surfaceLabel: 'Codex terminal • live',
        runtimeSurface: surface,
      } satisfies AgentSummary);
    }

    const activeCount = agents.filter((agent) => agent.status === 'running').length;
    const squad: SquadSummary = {
      id: 'squad-codex-local',
      name: 'Codex Local',
      status: activeCount > 0 ? 'healthy' : 'watching',
      throughputLabel: activeCount > 0 ? `${activeCount} live, ${agents.length} visible terminal surface${agents.length === 1 ? '' : 's'}` : `${agents.length} local terminal surface${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: 0,
      liveSessions: agents.length,
      members: agents.map((agent) => agent.id),
    };

    const events: EventItem[] = agents.slice(0, 4).map((agent) => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: agent.status === 'running' ? 'info' : agent.status === 'reviewing' ? 'warning' : 'warning',
      title: `${agent.name} • ${agent.surfaceLabel}`,
      detail: `${agent.currentTask} ${agent.runtimeSurface?.reviewContext?.repoSlug ? `• ${agent.runtimeSurface.reviewContext.repoSlug}` : ''}`.trim(),
      timestamp: agent.lastEventAt,
    }));

    const artifacts: ReviewArtifact[] = agents.slice(0, 3).map((agent) => ({
      kind: 'run_log',
      title: `${agent.name} tail`,
      state: 'reviewing',
      agentId: agent.id,
      detail: 'Readable rollout tail recovered from Codex runtime history.',
    }));

    return {
      agents,
      squads: [squad],
      events,
      artifacts,
      sourceLabel: CODEX_SOURCE_LABEL,
      note:
        activeCount > 0
          ? 'Codex runtime inventory distinguishes live pid-backed terminals from closed sessions. Both support resume via `codex exec resume <threadId>`, routed through the adapter.'
          : 'Codex local sessions are read from state_5.sqlite + rollout history. Closed sessions still accept input — the adapter spawns `codex exec resume <threadId> <message>` to continue the thread.',
    };
  } catch (error) {
    return {
      agents: [],
      squads: [],
      events: [],
      artifacts: [],
      note: error instanceof Error ? `Codex discovery unavailable: ${error.message}` : 'Codex discovery unavailable.',
    };
  }
  })();

  discoveredFleetInflight = promise;
  return promise.finally(() => {
    if (discoveredFleetInflight === promise) {
      discoveredFleetInflight = null;
    }
  }).then((value) => {
    if (generation === discoveredFleetGeneration) {
      discoveredFleetCache = { value, cachedAt: Date.now() };
    }
    return value;
  });
}

async function readTailChunk(filePath: string, maxBytes = 220_000) {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function parseTimestampLabel(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function extractTextParts(content: Array<Record<string, unknown>> | undefined) {
  if (!content?.length) return '';
  return content
    .filter((item) => item.type === 'output_text' || item.type === 'input_text')
    .map((item) => String(item.text ?? ''))
    .join(' ');
}

function extractReasoningSummary(summary: unknown) {
  if (!Array.isArray(summary)) return '';
  return summary
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.text === 'string') return candidate.text;
      if (typeof candidate.summary_text === 'string') return candidate.summary_text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function summarizeTailFromJsonl(raw: string) {
  const entries: RuntimeTailEntry[] = [];
  const lines = raw.split('\n').slice(-180);
  let pendingThinking = '';

  for (const line of lines) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(parsed.type ?? '');
    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    const timestampLabel = parseTimestampLabel(typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined);

    if (type === 'event_msg' && payload.type === 'agent_message') {
      const text = String(payload.message ?? '').trim();
      if (!text) continue;
      entries.push({
        id: `${entries.length}-event`,
        kind: 'event',
        label: 'Agent update',
        text,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'reasoning') {
      const text = extractReasoningSummary(payload.summary);
      if (text) {
        pendingThinking = text;
      }
      continue;
    }

    if (type === 'response_item' && payload.type === 'message') {
      const role = String(payload.role ?? 'message');
      const phase = compactText(String(payload.phase ?? ''), 32);
      const text = extractTextParts((payload.content ?? []) as Array<Record<string, unknown>>).trim();
      if (role !== 'assistant' && role !== 'user') continue;
      if (!text) continue;
      entries.push({
        id: `${entries.length}-message`,
        kind: 'message',
        label: compactText(`${role}${phase ? ` • ${phase}` : ''}`, 40),
        role: role === 'user' ? 'user' : 'assistant',
        text,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
        thinking: role === 'assistant' ? (pendingThinking || undefined) : undefined,
      });
      pendingThinking = '';
      continue;
    }

    if (
      (type === 'response_item' && payload.type === 'function_call')
      || (type === 'response_item' && payload.type === 'custom_tool_call')
    ) {
      const name = compactText(String(payload.name ?? 'tool'), 40);
      const rawToolInput = payload.type === 'custom_tool_call'
        ? payload.input
        : payload.arguments;
      const toolText = typeof rawToolInput === 'string'
        ? rawToolInput
        : JSON.stringify(rawToolInput ?? '');
      entries.push({
        id: `${entries.length}-tool`,
        kind: 'tool',
        label: name || 'Tool call',
        text: toolText || 'Tool invoked.',
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'function_call_output') {
      const text = compactText(String(payload.output ?? ''), 500);
      if (!text) continue;
      entries.push({
        id: `${entries.length}-tool-output`,
        kind: 'tool-output',
        label: 'Tool output',
        text,
        timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
        timestampLabel,
      });
      continue;
    }

    if (type === 'turn.completed') {
      const usage = (parsed.usage ?? payload.usage) as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
      const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : null;
      const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : null;
      if (input == null && output == null) continue;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const candidate = entries[index];
        if (candidate.kind !== 'message') continue;
        candidate.tokens = {
          input: input ?? 0,
          output: output ?? 0,
        };
        break;
      }
    }
  }

  return entries.slice(-50);
}

async function findCodexThreadBySurfaceId(surfaceId: string) {
  const threadId = surfaceId.replace(/^codex(?:-discovered|-live|-owned)?:/, '');
  return queryCodexThreadById(threadId);
}

export async function getCodexRolloutPath(surfaceId: string): Promise<string | null> {
  const thread = await findCodexThreadBySurfaceId(surfaceId);
  if (!thread) {
    return null;
  }

  const resolvedRollout = await realpath(thread.rollout_path).catch(() => null);
  const resolvedRoot = await realpath(CODEX_SESSIONS_ROOT).catch(() => null);
  if (!resolvedRollout || !resolvedRoot) {
    return null;
  }

  return resolvedRollout.startsWith(`${resolvedRoot}${path.sep}`) || resolvedRollout === resolvedRoot
    ? resolvedRollout
    : null;
}

export async function getCodexRuntimeTail(surfaceId: string): Promise<{
  surface: RuntimeSurfaceSummary;
  entries: RuntimeTailEntry[];
}> {
  const livePidMatch = surfaceId.match(/^codex-live:(\d+)$/);
  if (livePidMatch?.[1]) {
    const pid = Number(livePidMatch[1]);
    const liveProcesses = await queryAllLiveCodexProcesses();
    const proc = liveProcesses.get(pid);
    if (!proc) {
      throw new Error('Live Codex process was not found.');
    }

    const surface = buildSyntheticLiveProcessSurface(pid, proc);

    return {
      surface,
      entries: [{
        id: `live-${pid}-notice`,
        kind: 'event',
        label: 'Live process',
        text: `Live Codex process ${pid}${proc.tty ? ` on ${proc.tty}` : ''} is running in ${shortenPath(proc.cwd ?? '')}. Transcript and resume stay unavailable until Codex writes a durable thread binding.`,
      }],
    };
  }

  const thread = await findCodexThreadBySurfaceId(surfaceId);
  if (!thread) {
    throw new Error('Codex runtime surface was not found.');
  }

  const activityMap = await buildActivityMap([thread]);
  const resolvedRollout = await realpath(thread.rollout_path);
  const resolvedRoot = await realpath(CODEX_SESSIONS_ROOT);
  if (!resolvedRollout.startsWith(`${resolvedRoot}${path.sep}`) && resolvedRollout !== resolvedRoot) {
    throw new Error('Codex rollout path escaped the expected sessions root.');
  }

  const raw = await readTailChunk(resolvedRollout);
  return {
    surface: buildRuntimeSurface(thread, activityMap.get(thread.id)),
    entries: summarizeTailFromJsonl(raw),
  };
}
