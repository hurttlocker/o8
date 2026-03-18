import { execFile } from 'node:child_process';
import { access, open, realpath } from 'node:fs/promises';
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

const execFileAsync = promisify(execFile);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const CODEX_SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const CODEX_SOURCE_LABEL = 'Local Codex discovery';
const RECENT_WINDOW_MS = 6 * 60 * 60_000;

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
};

type CodexProcessBinding = {
  thread_id: string;
  process_uuid: string;
  last_ts: number;
};

type LiveCodexProcess = {
  pid: number;
  tty?: string;
  elapsed?: string;
  command?: string;
  cwd?: string;
};

type CodexThreadActivity = {
  lastLogTs?: number;
  pid?: number;
  tty?: string;
  active: boolean;
};

export type RuntimeTailEntry = {
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  label: string;
  text: string;
  timestampLabel?: string;
};

function compactText(value: string | null | undefined, max = 120) {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
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
  const repoSlug = repoSlugFromOrigin(thread.git_origin_url);
  if (repoSlug) {
    return repoSlug.split('/').pop() ?? repoSlug;
  }

  return path.basename(thread.cwd) || 'codex';
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
    "coalesce(first_user_message, '') as first_user_message",
    'from threads',
    'where archived = 0',
    'order by updated_at desc',
    `limit ${limit};`,
  ].join(' ');

  const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], {
    maxBuffer: 2 * 1024 * 1024,
  });

  const parsed = JSON.parse(stdout || '[]') as CodexThreadRow[];
  return parsed.filter((row) => row.id && row.rollout_path && row.cwd);
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

  const { stdout } = await execFileAsync('sqlite3', ['-json', CODEX_STATE_DB, query], {
    maxBuffer: 2 * 1024 * 1024,
  });

  return JSON.parse(stdout || '[]') as CodexProcessBinding[];
}

async function readProcessCwd(pid: number) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
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

async function queryLiveCodexProcesses(pids: number[]) {
  if (!pids.length) {
    return new Map<number, LiveCodexProcess>();
  }

  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'pid=', '-o', 'tt=', '-o', 'etime=', '-o', 'command=', '-p', pids.join(',')],
      {
        maxBuffer: 512 * 1024,
      },
    );

    const rows: LiveCodexProcess[] = [];
    for (const line of stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isFinite(pid)) continue;
      const row: LiveCodexProcess = {
        pid,
        tty: match[2],
        elapsed: match[3],
        command: match[4],
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
        });
      }),
    );
    return result;
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

function deriveStatus(thread: CodexThreadRow, activity?: CodexThreadActivity): AgentSummary['status'] {
  const activityState = classifyActivity(thread, activity);
  if (activityState === 'active') return 'running';
  if (activityState === 'recent') return 'reviewing';
  return 'idle';
}

function buildRuntimeSurface(thread: CodexThreadRow, activity?: CodexThreadActivity): RuntimeSurfaceSummary {
  const repoSlug = repoSlugFromOrigin(thread.git_origin_url);
  const activityState = classifyActivity(thread, activity);
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
      sendInput: false,
      interrupt: false,
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

  // Fallback: find ALL live Codex processes via ps and match by CWD
  // This catches new sessions that haven't written process_uuid to the DB yet
  try {
    const { stdout: psOut } = await execFileAsync(
      'bash', ['-c', 'ps -eo pid=,command= | grep codex | grep -v grep'],
      { maxBuffer: 256 * 1024 },
    );
    const allPids: number[] = [];
    for (const line of psOut.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const pidMatch = line.match(/^(\d+)/);
      if (pidMatch) {
        const pid = Number(pidMatch[1]);
        if (Number.isFinite(pid) && line.includes('/codex')) allPids.push(pid);
      }
    }
    const allLive = await queryLiveCodexProcesses(allPids);
    for (const [pid, proc] of allLive) {
      if (!proc.cwd) continue;
      const normalizedCwd = normalizeFsPath(proc.cwd);
      // Find threads in this CWD that aren't already marked active
      for (const thread of threads) {
        if (normalizeFsPath(thread.cwd) !== normalizedCwd) continue;
        const existing = byThreadId.get(thread.id);
        if (existing?.active) continue;
        // Match the most recently updated thread for this CWD
        byThreadId.set(thread.id, {
          ...existing,
          active: true,
          pid,
          tty: proc.tty,
          lastLogTs: existing?.lastLogTs ?? thread.updated_at,
        });
        break; // One process per CWD match
      }
    }
  } catch { /* ps fallback not available */ }

  return byThreadId;
}

export async function getCodexDiscoveredFleetAdditions(): Promise<{
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
}> {
  try {
    const threads = await queryCodexThreads();
    if (!threads.length) {
      return {
        agents: [],
        squads: [],
        events: [],
        artifacts: [],
      };
    }

    const activityMap = await buildActivityMap(threads);

    const agents: AgentSummary[] = threads.map((thread) => {
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
        model: 'codex local',
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
          ? 'Codex runtime inventory now distinguishes live pid-backed terminals from recent session history. Mutation stays disabled until a truthful input/interrupt seam exists.'
          : 'Codex local sessions are surfaced read-only for now from state_5.sqlite + rollout history. Mutation stays disabled until a truthful input/interrupt seam exists.',
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

function summarizeTailFromJsonl(raw: string) {
  const entries: RuntimeTailEntry[] = [];
  const lines = raw.split('\n').slice(-180);

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
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'message') {
      const role = String(payload.role ?? 'message');
      const phase = compactText(String(payload.phase ?? ''), 32);
      const text = extractTextParts((payload.content ?? []) as Array<Record<string, unknown>>).trim();
      if (!text) continue;
      entries.push({
        id: `${entries.length}-message`,
        kind: 'message',
        label: compactText(`${role}${phase ? ` • ${phase}` : ''}`, 40),
        text,
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'function_call') {
      const name = compactText(String(payload.name ?? 'tool'), 40);
      entries.push({
        id: `${entries.length}-tool`,
        kind: 'tool',
        label: name || 'Tool call',
        text: compactText(String(payload.arguments ?? ''), 500) || 'Tool invoked.',
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
        timestampLabel,
      });
    }
  }

  return entries.slice(-50);
}

async function findCodexThreadBySurfaceId(surfaceId: string) {
  const threadId = surfaceId.startsWith('codex:') ? surfaceId.slice('codex:'.length) : surfaceId;
  const threads = await queryCodexThreads(24);
  return threads.find((thread) => thread.id === threadId) ?? null;
}

export async function getCodexRuntimeTail(surfaceId: string): Promise<{
  surface: RuntimeSurfaceSummary;
  entries: RuntimeTailEntry[];
}> {
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
