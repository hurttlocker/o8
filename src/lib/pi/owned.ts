import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session';
import { resolveRepoContext, validateWorkspace } from '@/lib/runtimes/shared/owned-session/helpers';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import {
  buildPiPermissionDefaultResponse,
  buildPiPermissionDeniedResponse,
  handlePiPermissionRequest,
} from '@/lib/pi/permission-bridge';
import type {
  AgentSummary,
  EventItem,
  RuntimeReviewPacket,
  RuntimeSurfaceSummary,
  SquadSummary,
  ReviewArtifact,
} from '@/lib/fleet/types';
import type { OwnedTailEntry, OwnedTailGroup } from '@/lib/runtimes/shared/owned-session/types';
import { getDataDir } from '@/lib/data-dir-migration';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

export {
  buildPiPermissionDefaultResponse,
  handlePiPermissionRequest,
  PI_PERMISSION_APPROVAL_TIMEOUT_MS,
} from '@/lib/pi/permission-bridge';

type PiRunOutcome = 'running' | 'finished' | 'interrupted' | 'failed';
type PiRunMode = 'launch' | 'resume';

interface PiRunRecord {
  id: string;
  mode: PiRunMode;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  outcome: PiRunOutcome;
  stdoutPath: string;
  stderrPath: string;
  pid?: number;
}

interface PiSessionRecord {
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
  latestPrompt: string;
  latestSummary: string;
  model?: string;
  piSessionId?: string;
  piSessionFile?: string;
  reviewDisposition?: 'watching' | 'resolved';
  reviewDispositionUpdatedAt?: string;
  activeRun?: PiRunRecord;
  recentRuns: PiRunRecord[];
}

interface PiRpcClient {
  child: ChildProcess;
  send(command: Record<string, unknown>): boolean;
}

export type PiRpcFrame = Record<string, unknown>;

const PI_ROOT = process.env.O8_OWNED_PI_ROOT ?? path.join(getDataDir(), 'owned-pi');
const RUNS_DIR = 'runs';
const SURFACE_PREFIX = 'pi-owned:';
const SESSION_PREFIX = 'pi-owned-';
const activeClients = new Map<string, PiRpcClient>();

function nowIso() {
  return new Date().toISOString();
}

function metadataPath(sessionDir: string) {
  return path.join(sessionDir, 'session.json');
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function splitPiRpcJsonlFrames(chunk: Buffer, carry = ''): { lines: string[]; carry: string } {
  const text = carry + chunk.toString('utf8');
  const parts = text.split('\n');
  return {
    lines: parts.slice(0, -1).map((line) => line.endsWith('\r') ? line.slice(0, -1) : line),
    carry: parts.at(-1) ?? '',
  };
}

function eventText(frame: PiRpcFrame): string {
  const type = String(frame.type ?? '');
  if (type === 'message_update') {
    const event = safeRecord(frame.assistantMessageEvent);
    const eventType = readString(event, 'type');
    const delta = readString(event, 'delta', 'text');
    if (delta) return delta;
    if (eventType) return eventType;
  }
  if (type === 'tool_execution_start') {
    return `Started ${readString(frame, 'toolName', 'tool_name') ?? 'tool'} ${stringify(frame.args ?? '')}`.trim();
  }
  if (type === 'tool_execution_update') {
    return stringify(frame.partialResult ?? frame.result ?? '');
  }
  if (type === 'tool_execution_end') {
    return stringify(frame.result ?? '');
  }
  if (type === 'extension_ui_request') {
    return stringify(frame);
  }
  if (type === 'response') {
    return `${readString(frame, 'command') ?? 'command'} ${frame.success === false ? 'failed' : 'accepted'}`;
  }
  return readString(frame, 'message', 'error', 'errorMessage') ?? '';
}

function parsePiRunLog(raw: string, run: PiRunRecord): { entries: OwnedTailEntry[]; completed: boolean; sessionId?: string; sessionFile?: string } {
  const entries: OwnedTailEntry[] = [{
    id: `${run.id}:prompt`,
    kind: 'event',
    label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
    text: compactText(run.prompt, 400),
    timestamp: run.startedAt,
    timestampLabel: formatClock(run.startedAt),
  }];
  let completed = false;
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let textBuffer = '';

  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let frame: PiRpcFrame;
    try {
      frame = JSON.parse(trimmed) as PiRpcFrame;
    } catch {
      return;
    }
    const type = String(frame.type ?? '');
    if (type === 'session') {
      sessionId = readString(frame, 'id');
      return;
    }
    if (type === 'response' && frame.command === 'get_state') {
      const data = safeRecord(frame.data);
      sessionId = readString(data, 'sessionId') ?? sessionId;
      sessionFile = readString(data, 'sessionFile') ?? sessionFile;
      return;
    }
    if (type === 'message_update') {
      const event = safeRecord(frame.assistantMessageEvent);
      const eventType = readString(event, 'type');
      const delta = readString(event, 'delta', 'text');
      if ((eventType === 'text_delta' || eventType === 'thinking_delta') && delta) {
        textBuffer += delta;
        return;
      }
    }
    if (textBuffer.trim()) {
      entries.push({
        id: `${run.id}:message:${index}`,
        kind: 'message',
        label: 'Pi',
        text: compactText(textBuffer.trim(), 1000),
        timestamp: run.finishedAt ?? run.startedAt,
        timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
      });
      textBuffer = '';
    }
    if (type === 'agent_end') completed = true;
    const text = eventText(frame).trim();
    if (!text || type === 'agent_start' || type === 'turn_start' || type === 'message_start' || type === 'message_end') return;
    entries.push({
      id: `${run.id}:${type}:${index}`,
      kind: type.startsWith('tool_execution') ? (type === 'tool_execution_start' ? 'tool' : 'tool-output') : 'event',
      label: type === 'extension_ui_request' ? 'Permission request denied' : type,
      text: compactText(text, 800),
      timestamp: run.finishedAt ?? run.startedAt,
      timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
    });
  });

  if (textBuffer.trim()) {
    entries.push({
      id: `${run.id}:message:tail`,
      kind: 'message',
      label: 'Pi',
      text: compactText(textBuffer.trim(), 1000),
      timestamp: run.finishedAt ?? run.startedAt,
      timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
    });
  }
  return { entries, completed, sessionId, sessionFile };
}

async function ensureRoot() {
  await mkdir(PI_ROOT, { recursive: true });
  return PI_ROOT;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function listSessionDirs() {
  const root = await ensureRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

async function findSession(surfaceId: string) {
  for (const dir of await listSessionDirs()) {
    const session = await readJson<PiSessionRecord>(metadataPath(dir));
    if (session?.surfaceId === surfaceId) return session;
  }
  return null;
}

async function saveSession(session: PiSessionRecord) {
  session.updatedAt = nowIso();
  await writeJson(metadataPath(session.sessionDir), session);
}

async function appendRunLine(run: PiRunRecord, frame: unknown) {
  await appendFile(run.stdoutPath, `${JSON.stringify(frame)}\n`, 'utf8');
}

async function resolvePiBinary() {
  return (await resolveCli({
    runtimeId: 'pi',
    binaryName: 'pi',
    envOverride: 'O8_PI_BIN',
    versionArgs: ['--version'],
  })).path;
}

function commandId(prefix: string) {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 6)}`;
}

function send(client: PiRpcClient, command: Record<string, unknown>) {
  return client.send(command);
}

async function spawnRpcProcess(session: PiSessionRecord, run: PiRunRecord, initialCommand: 'prompt' | 'follow_up') {
  const binary = await resolvePiBinary();
  const args = ['--mode', 'rpc', '--name', session.title];
  if (session.model) args.push('--model', session.model);
  if (session.piSessionFile && run.mode === 'resume') args.push('--session', session.piSessionFile);
  const launch = cliInvocation(binary, args);
  const child = spawn(launch.command, launch.args, {
    windowsHide: true,
    cwd: session.repoPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  run.pid = child.pid;
  let carry = '';
  const client: PiRpcClient = {
    child,
    send(command) {
      if (!child.stdin || child.killed) return false;
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    },
  };
  activeClients.set(session.surfaceId, client);

  child.stdout.on('data', (chunk: Buffer) => {
    const split = splitPiRpcJsonlFrames(chunk, carry);
    carry = split.carry;
    for (const line of split.lines) {
      if (!line.trim()) continue;
      let frame: PiRpcFrame;
      try {
        frame = JSON.parse(line) as PiRpcFrame;
      } catch {
        void appendFile(run.stderrPath, `Malformed Pi RPC frame: ${line}\n`, 'utf8');
        continue;
      }
      void appendRunLine(run, frame);
      if (frame.type === 'session') {
        session.piSessionId = readString(frame, 'id') ?? session.piSessionId;
        void saveSession(session);
      }
      if (frame.type === 'response' && frame.command === 'get_state') {
        const data = safeRecord(frame.data);
        session.piSessionId = readString(data, 'sessionId') ?? session.piSessionId;
        session.piSessionFile = readString(data, 'sessionFile') ?? session.piSessionFile;
        void saveSession(session);
      }
      if (frame.type === 'extension_ui_request') {
        void appendRunLine(run, { type: 'o8_permission_gate_requested', action: 'approval_or_safe_default' });
        void handlePiPermissionRequest(frame, session, client)
          .then((outcome) => {
            void appendRunLine(run, { type: 'o8_permission_gate_resolved', outcome });
          })
          .catch((error) => {
            void appendRunLine(run, {
              type: 'o8_permission_gate_default',
              action: 'deny_or_cancel',
              error: error instanceof Error ? error.message : String(error),
            });
            const response = buildPiPermissionDeniedResponse(frame, 'Approval bridge failed; denied by default.');
            if (response) send(client, response);
          });
      }
      if (frame.type === 'agent_end') {
        run.outcome = 'finished';
        run.finishedAt = nowIso();
        session.activeRun = undefined;
        session.latestSummary = 'Pi turn completed.';
        void saveSession(session);
        send(client, { id: commandId('state'), type: 'get_state' });
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    void appendFile(run.stderrPath, chunk);
  });
  child.on('exit', (code, signal) => {
    activeClients.delete(session.surfaceId);
    if (run.outcome === 'running') {
      run.outcome = signal ? 'interrupted' : code === 0 ? 'finished' : 'failed';
      run.finishedAt = nowIso();
      session.activeRun = undefined;
      void saveSession(session);
    }
  });

  await saveSession(session);
  send(client, { id: commandId(initialCommand), type: initialCommand, message: run.prompt });
  return client;
}

async function startRun(session: PiSessionRecord, prompt: string, mode: PiRunMode, command: 'prompt' | 'follow_up' = 'prompt') {
  await mkdir(path.join(session.sessionDir, RUNS_DIR), { recursive: true });
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const run: PiRunRecord = {
    id: runId,
    mode,
    prompt,
    startedAt: nowIso(),
    outcome: 'running',
    stdoutPath: path.join(session.sessionDir, RUNS_DIR, `${runId}.jsonl`),
    stderrPath: path.join(session.sessionDir, RUNS_DIR, `${runId}.stderr.log`),
  };
  session.latestPrompt = prompt;
  session.latestSummary = compactText(prompt, 140);
  session.reviewDisposition = 'watching';
  session.reviewDispositionUpdatedAt = nowIso();
  session.activeRun = run;
  session.recentRuns = [run, ...session.recentRuns].slice(0, 16);
  await saveSession(session);
  await spawnRpcProcess(session, run, command);
  return run;
}

function buildSurface(session: PiSessionRecord): RuntimeSurfaceSummary {
  const running = Boolean(session.activeRun);
  const latest = session.recentRuns[0];
  return {
    id: session.surfaceId,
    runtime: 'pi',
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: session.repoPath.replace(os.homedir(), '~'),
    branch: session.branch,
    sourceLabel: running ? `IDE-owned Pi RPC • active pid ${session.activeRun?.pid ?? 'unknown'}` : 'IDE-owned Pi RPC • ready',
    tailSourceLabel: `${session.sessionDir}/${RUNS_DIR}/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: true,
      interrupt: running,
      resize: false,
      diffContext: Boolean(session.branch || session.repoSlug),
      reviewContext: Boolean(session.branch || session.repoSlug),
    },
    lifecycle: {
      availability: running ? 'running' : 'ready-for-resume',
      lastOutcome: latest?.outcome === 'finished' || latest?.outcome === 'interrupted' || latest?.outcome === 'failed' ? latest.outcome : undefined,
      lastRunMode: latest?.mode,
      lastRunStartedAt: latest?.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: running ? 'Active Pi RPC turn in flight.' : 'Pi RPC session is ready for native steer or follow-up.',
    },
    reviewContext: {
      repoSlug: session.repoSlug,
      branch: session.branch,
      head: session.head,
    },
  };
}

async function tailForSession(session: PiSessionRecord) {
  const runs = [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const entries: OwnedTailEntry[] = [];
  const groups: OwnedTailGroup[] = [];
  for (const run of runs) {
    const raw = await readFile(run.stdoutPath, 'utf8').catch(() => '');
    const parsed = parsePiRunLog(raw, run);
    session.piSessionId = session.piSessionId ?? parsed.sessionId;
    session.piSessionFile = session.piSessionFile ?? parsed.sessionFile;
    entries.push(...parsed.entries);
    groups.push({
      id: run.id,
      title: `${run.mode === 'launch' ? 'Pi RPC launch turn' : 'Pi RPC resume turn'} • ${run.outcome}`,
      mode: run.mode,
      outcome: run.outcome,
      prompt: compactText(run.prompt, 8000),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startedAtLabel: formatClock(run.startedAt),
      finishedAtLabel: formatClock(run.finishedAt),
      summary: parsed.entries.at(-1)?.text ?? session.latestSummary,
      entries: parsed.entries,
    });
  }
  await saveSession(session);
  return { surface: buildSurface(session), entries, groups };
}

export async function launchOwnedPiSession(request: { cwd: string; prompt: string; model?: string }) {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  const repoPath = await validateWorkspace(request.cwd);
  const repo = await resolveRepoContext(repoPath);
  const id = `${SESSION_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(await ensureRoot(), id);
  await mkdir(sessionDir, { recursive: true });
  const session: PiSessionRecord = {
    surfaceId: `${SURFACE_PREFIX}${id}`,
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
    latestSummary: compactText(prompt, 140),
    model: request.model?.trim() || undefined,
    reviewDisposition: 'watching',
    reviewDispositionUpdatedAt: nowIso(),
    recentRuns: [],
  };
  await saveSession(session);
  await startRun(session, prompt, 'launch');
  return { ok: true, runtime: 'pi' as const, surfaceId: session.surfaceId, note: `Owned Pi RPC run launched for ${repo.title}.` };
}

export async function steerOwnedPiSession(surfaceId: string, message: string) {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned Pi session was not found.');
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, note: 'message is required' };
  const client = activeClients.get(surfaceId);
  if (client && session.activeRun) {
    const ok = send(client, { id: commandId('steer'), type: 'steer', message: trimmed });
    return { ok, note: ok ? 'Queued Pi native RPC steer.' : 'Pi RPC process could not accept steer.' };
  }
  await startRun(session, trimmed, 'resume', 'follow_up');
  return { ok: true, note: 'Started a Pi RPC follow-up session.' };
}

export async function interruptOwnedPiSession(surfaceId: string) {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned Pi session was not found.');
  const client = activeClients.get(surfaceId);
  if (client) {
    send(client, { id: commandId('abort'), type: 'abort' });
    client.child.kill('SIGINT');
  }
  if (session.activeRun) {
    session.activeRun.outcome = 'interrupted';
    session.activeRun.finishedAt = nowIso();
    session.recentRuns = session.recentRuns.map((run) => run.id === session.activeRun?.id ? session.activeRun : run);
    session.activeRun = undefined;
    await saveSession(session);
  }
  activeClients.delete(surfaceId);
  return { interrupted: true, note: 'Interrupt sent to Pi RPC session.' };
}

export async function getOwnedPiRuntimeTail(surfaceId: string) {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned Pi session was not found.');
  return tailForSession(session);
}

export async function getOwnedPiFleetAdditions(): Promise<{ agents: AgentSummary[]; squads: SquadSummary[]; events: EventItem[]; artifacts: ReviewArtifact[]; ownedThreadIds: string[]; sourceLabel: string }> {
  const sessions = (await Promise.all((await listSessionDirs()).map((dir) => readJson<PiSessionRecord>(metadataPath(dir)))))
    .filter((session): session is PiSessionRecord => Boolean(session));
  const agents: AgentSummary[] = sessions.map((session) => {
    const surface = buildSurface(session);
    const running = Boolean(session.activeRun);
    return {
      id: session.surfaceId,
      name: session.title,
      squadId: 'squad-pi-owned',
      runtime: 'pi',
      model: session.model ?? 'pi default',
      status: running ? 'running' : 'reviewing',
      currentTask: session.latestSummary,
      workspace: session.repoPath,
      branch: session.branch ?? '',
      sessionKey: session.surfaceId,
      approvalStatus: 'none',
      lastEventAt: session.updatedAt,
      context: { usedPercent: 0, trend: 'stable' },
      alerts: 0,
      runtimeSurface: surface,
    };
  });
  return {
    agents,
    squads: [{
      id: 'squad-pi-owned',
      name: 'Pi Owned',
      status: agents.some((agent) => agent.status === 'running') ? 'watching' : 'healthy',
      throughputLabel: `${agents.length} Pi session${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: 0,
      liveSessions: agents.filter((agent) => agent.status === 'running').length,
      members: agents.map((agent) => agent.id),
    }],
    events: [],
    artifacts: [],
    ownedThreadIds: sessions.map((session) => session.piSessionId).filter((id): id is string => Boolean(id)),
    sourceLabel: 'Owned Pi RPC sessions',
  };
}

export async function getOwnedPiReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket> {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned Pi session was not found.');
  const review = await getRuntimeRepoReview(session.repoPath);
  const latest = session.recentRuns[0];
  return {
    surfaceId,
    runtime: 'pi',
    title: session.title,
    summary: session.latestSummary,
    repoPath: session.repoPath.replace(os.homedir(), '~'),
    repoSlug: session.repoSlug,
    branch: review.branch ?? session.branch,
    head: review.head ?? session.head,
    dirty: review.dirty,
    diffStat: review.diffStat,
    changedFiles: review.changedFiles,
    recentCommits: review.recentCommits,
    reviewDisposition: session.reviewDisposition ?? 'watching',
    reviewDispositionUpdatedAt: session.reviewDispositionUpdatedAt,
    lastRun: latest ? {
      id: latest.id,
      mode: latest.mode,
      outcome: latest.outcome,
      prompt: latest.prompt,
      startedAt: latest.startedAt,
      finishedAt: latest.finishedAt,
      startedAtLabel: formatClock(latest.startedAt),
      finishedAtLabel: formatClock(latest.finishedAt),
      assistantSummary: session.latestSummary,
      commands: [],
    } : undefined,
    nextActions: [],
    notes: [],
  };
}

export async function getOwnedPiTelemetrySources(surfaceId: string) {
  const session = await findSession(surfaceId);
  if (!session) return null;
  return {
    threadId: session.piSessionId,
    stdoutPaths: [...session.recentRuns].reverse().map((run) => run.stdoutPath),
  };
}

export async function setOwnedPiReviewDisposition(surfaceId: string, disposition: 'watching' | 'resolved') {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned Pi session was not found.');
  session.reviewDisposition = disposition;
  session.reviewDispositionUpdatedAt = nowIso();
  await saveSession(session);
  return { disposition, note: disposition === 'resolved' ? 'Marked Pi result resolved.' : 'Watching Pi result.' };
}

export function invalidateOwnedPiFleetCache(): void {
  // Pi owned sessions are read directly; no cache is held in this bounded adapter.
}

export async function archiveOwnedPiSession(surfaceId: string) {
  await interruptOwnedPiSession(surfaceId).catch(() => null);
  return { archived: false, note: 'Pi archival is not implemented yet; session remains in the owned store.' };
}

export async function sweepOrphanedPiSessions() {
  return 0;
}
