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

type CodexThreadRow = {
  id: string;
  title: string;
  cwd: string;
  updated_at: number;
  rollout_path: string;
  git_branch?: string | null;
  git_sha?: string | null;
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

function relativeAge(updatedAtSeconds: number) {
  const ageMs = Math.max(0, Date.now() - updatedAtSeconds * 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

function deriveStatus(updatedAtSeconds: number): AgentSummary['status'] {
  const ageMs = Math.max(0, Date.now() - updatedAtSeconds * 1000);
  if (ageMs < 15 * 60_000) return 'running';
  if (ageMs < 6 * 60 * 60_000) return 'reviewing';
  return 'idle';
}

function buildRuntimeSurface(thread: CodexThreadRow): RuntimeSurfaceSummary {
  return {
    id: `codex:${thread.id}`,
    runtime: 'codex',
    kind: 'terminal-session',
    title: compactTitle(thread.title),
    cwd: shortenPath(thread.cwd),
    branch: thread.git_branch || undefined,
    sourceLabel: CODEX_SOURCE_LABEL,
    tailSourceLabel: '~/.codex/sessions/*.jsonl',
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: false,
      interrupt: false,
      resize: false,
      diffContext: Boolean(thread.git_branch),
      reviewContext: Boolean(thread.git_branch),
    },
    reviewContext: {
      branch: thread.git_branch || undefined,
      head: thread.git_sha || undefined,
    },
  };
}

async function codexStateExists() {
  try {
    await access(CODEX_STATE_DB);
    return true;
  } catch {
    return false;
  }
}

async function queryCodexThreads(limit = 4) {
  if (!await codexStateExists()) {
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
    "coalesce(git_sha, '') as git_sha",
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

    const agents: AgentSummary[] = threads.map((thread) => {
      const surface = buildRuntimeSurface(thread);
      const status = deriveStatus(thread.updated_at);
      const branch = thread.git_branch || 'detached';
      const workspace = shortenPath(thread.cwd);

      return {
        id: `codex:${thread.id}`,
        name: compactTitle(thread.title, 40),
        squadId: 'squad-codex-local',
        runtime: 'codex',
        model: 'codex local',
        status,
        currentTask:
          status === 'running'
            ? 'Recent local Codex session discovered from ~/.codex. Tail is readable; input and interrupt are not wired yet.'
            : 'Discovered local Codex session. Runtime watch is available; mutation controls remain intentionally disabled.',
        workspace,
        branch,
        sessionKey: surface.id,
        approvalStatus: 'none',
        lastEventAt: relativeAge(thread.updated_at),
        context: {
          usedPercent: 0,
          trend: 'stable',
        },
        alerts: 0,
        sessionId: thread.id,
        sessionKind: 'terminal',
        surfaceLabel: 'Codex terminal',
        runtimeSurface: surface,
      } satisfies AgentSummary;
    });

    const squad: SquadSummary = {
      id: 'squad-codex-local',
      name: 'Codex Local',
      status: agents.some((agent) => agent.status === 'running') ? 'healthy' : 'watching',
      throughputLabel: `${agents.length} local terminal surface${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: 0,
      liveSessions: agents.length,
      members: agents.map((agent) => agent.id),
    };

    const events: EventItem[] = agents.slice(0, 3).map((agent) => ({
      id: `evt-${agent.id}`,
      agentId: agent.id,
      squadId: agent.squadId,
      severity: agent.status === 'running' ? 'info' : 'warning',
      title: `${agent.name} • Codex terminal`,
      detail: `${agent.currentTask} ${agent.branch !== 'detached' ? `• ${agent.branch}` : ''}`.trim(),
      timestamp: agent.lastEventAt,
    }));

    const artifacts: ReviewArtifact[] = agents.slice(0, 2).map((agent) => ({
      kind: 'run_log',
      title: `${agent.name} tail`,
      state: 'reviewing',
      agentId: agent.id,
      detail: 'Readable rollout tail recovered from local Codex session metadata.',
    }));

    return {
      agents,
      squads: [squad],
      events,
      artifacts,
      sourceLabel: CODEX_SOURCE_LABEL,
      note: 'Codex local sessions are surfaced read-only for now: attach/read-tail yes, send-input/interrupt no until semantics are cleaner.',
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
      const text = compactText(String(payload.message ?? ''), 240);
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
      const text = compactText(extractTextParts((payload.content ?? []) as Array<Record<string, unknown>>), 280);
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
        text: compactText(String(payload.arguments ?? ''), 220) || 'Tool invoked.',
        timestampLabel,
      });
      continue;
    }

    if (type === 'response_item' && payload.type === 'function_call_output') {
      const text = compactText(String(payload.output ?? ''), 240);
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

  return entries.slice(-24);
}

async function findCodexThreadBySurfaceId(surfaceId: string) {
  const threadId = surfaceId.startsWith('codex:') ? surfaceId.slice('codex:'.length) : surfaceId;
  const threads = await queryCodexThreads(20);
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

  const resolvedRollout = await realpath(thread.rollout_path);
  const resolvedRoot = await realpath(CODEX_SESSIONS_ROOT);
  if (!resolvedRollout.startsWith(`${resolvedRoot}${path.sep}`) && resolvedRollout !== resolvedRoot) {
    throw new Error('Codex rollout path escaped the expected sessions root.');
  }

  const raw = await readTailChunk(resolvedRollout);
  return {
    surface: buildRuntimeSurface(thread),
    entries: summarizeTailFromJsonl(raw),
  };
}
