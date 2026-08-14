import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeReviewPacket,
  RuntimeSurfaceSummary,
  SquadSummary,
} from '@/lib/fleet/types';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { getDataDir } from '@/lib/data-dir-migration';
import { escalateInterrupt } from '@/lib/runtime/interrupt-escalation';
import {
  archiveOwnedSessionDir,
  archivedSessionPathForSurfaceId,
  readOwnedSessionState,
} from '@/lib/runtimes/shared/owned-session/archive';
import {
  compactText,
  ensureDir,
  formatClock,
  isPidAlive,
  metadataPath,
  nowIso,
  pidCommandLine,
  readJsonFile,
  resolveRepoContext,
  validateWorkspace,
  writeJsonFile,
} from '@/lib/runtimes/shared/owned-session/helpers';
import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import type {
  OwnedSessionRecord,
  OwnedTailEntry,
  OwnedTailGroup,
} from '@/lib/runtimes/shared/owned-session/types';
import {
  StdioJsonRpcPeer,
  type StdioJsonRpcInboundRequest,
  type StdioJsonRpcNotification,
} from '@/lib/runtimes/shared/stdio-json-rpc';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import {
  DEEPSEEK_HARNESS_SERVER_NAME,
  parseDeepSeekHarnessRunLog,
  type DeepSeekHarnessRunRecord,
  validateDeepSeekHarnessInitialize,
  validateDeepSeekHarnessNewSession,
  validateDeepSeekHarnessPrompt,
} from './protocol';
import { resolveDeepSeekHarnessLaunch } from './runtime-resolution';

const SURFACE_PREFIX = 'deepseek-harness-owned:';
const SESSION_PREFIX = 'deepseek-harness-owned-';
const RUNS_DIR = 'runs';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const TURN_TIMEOUT_MS = 14_400_000;

interface DeepSeekHarnessSessionRecord {
  surfaceId: string;
  launchMutationId?: string;
  laneId?: string;
  packetId?: string;
  sessionDir: string;
  cwd: string;
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  latestPrompt: string;
  latestSummary: string;
  model: string;
  reviewDisposition?: 'watching' | 'resolved';
  reviewDispositionUpdatedAt?: string;
  activeRun?: DeepSeekHarnessRunRecord;
  recentRuns: DeepSeekHarnessRunRecord[];
  rpcPid?: number;
  commandIdentity?: string;
  serverVersion?: string;
}

interface ActiveHarnessProcess {
  peer: StdioJsonRpcPeer;
  sessionId: string;
}

const activeProcesses = new Map<string, ActiveHarnessProcess>();
const sessionChains = new Map<string, Promise<unknown>>();

function root(): string {
  return process.env.O8_OWNED_DEEPSEEK_HARNESS_ROOT
    || path.join(getDataDir(), 'owned-deepseek-harness');
}

function withSession<T>(surfaceId: string, fn: () => Promise<T>): Promise<T> {
  return chainOnKey(sessionChains, surfaceId, fn);
}

async function listDirs(base = root()): Promise<string[]> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(base, entry.name));
}

async function loadSession(sessionDir: string): Promise<DeepSeekHarnessSessionRecord | null> {
  return readJsonFile<DeepSeekHarnessSessionRecord>(metadataPath(sessionDir)).catch(() => null);
}

function rebaseArchivedSession(session: DeepSeekHarnessSessionRecord, sessionDir: string): DeepSeekHarnessSessionRecord {
  const rebaseRun = (run: DeepSeekHarnessRunRecord): DeepSeekHarnessRunRecord => ({
    ...run,
    stdoutPath: path.join(sessionDir, RUNS_DIR, path.basename(run.stdoutPath)),
    stderrPath: path.join(sessionDir, RUNS_DIR, path.basename(run.stderrPath)),
  });
  return {
    ...session,
    sessionDir,
    activeRun: session.activeRun ? rebaseRun(session.activeRun) : undefined,
    recentRuns: session.recentRuns.map(rebaseRun),
  };
}

async function findSession(surfaceId: string, includeArchive = true): Promise<DeepSeekHarnessSessionRecord | null> {
  for (const sessionDir of await listDirs()) {
    const session = await loadSession(sessionDir);
    if (session?.surfaceId === surfaceId) return session;
  }
  if (!includeArchive) return null;
  const archivedPath = await archivedSessionPathForSurfaceId(root(), surfaceId, SURFACE_PREFIX);
  if (!archivedPath) return null;
  const archived = await loadSession(archivedPath);
  return archived?.surfaceId === surfaceId ? rebaseArchivedSession(archived, archivedPath) : null;
}

async function saveSession(session: DeepSeekHarnessSessionRecord): Promise<void> {
  session.updatedAt = nowIso();
  await writeJsonFile(metadataPath(session.sessionDir), session, { mode: 0o600 });
}

function replaceRun(session: DeepSeekHarnessSessionRecord, run: DeepSeekHarnessRunRecord): void {
  session.recentRuns = session.recentRuns.map((candidate) => candidate.id === run.id ? run : candidate);
  if (session.activeRun?.id === run.id) session.activeRun = run;
}

function acpUpdateText(notification: StdioJsonRpcNotification): string | null {
  if (notification.method !== 'session/update') return null;
  const update = notification.params.update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const record = update as Record<string, unknown>;
  if (record.sessionUpdate !== 'agent_message_chunk') return null;
  const content = record.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const text = (content as Record<string, unknown>).text;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function handleAcpRequest(peer: StdioJsonRpcPeer, request: StdioJsonRpcInboundRequest): void {
  if (request.method !== 'session/request_permission') {
    peer.respondError(request.id, -32601, `Unsupported ACP request: ${request.method}`);
    return;
  }
  const options = Array.isArray(request.params.options) ? request.params.options : [];
  const allowOnce = options.find((option) => (
    option
    && typeof option === 'object'
    && !Array.isArray(option)
    && (option as Record<string, unknown>).kind === 'allow_once'
    && typeof (option as Record<string, unknown>).optionId === 'string'
  )) as Record<string, unknown> | undefined;
  if (!allowOnce) {
    peer.respond(request.id, { outcome: { outcome: 'cancelled' } });
    return;
  }
  peer.respond(request.id, {
    outcome: { outcome: 'selected', optionId: allowOnce.optionId },
  });
}

async function handleNotification(
  surfaceId: string,
  notification: StdioJsonRpcNotification,
): Promise<void> {
  await withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    const run = session?.activeRun;
    if (!session || !run) return;
    await appendFile(run.stdoutPath, `${JSON.stringify({
      jsonrpc: '2.0',
      method: notification.method,
      params: notification.params,
    })}\n`, 'utf8');
    const text = acpUpdateText(notification);
    if (text) session.latestSummary = compactText(text, 2_000);
    replaceRun(session, run);
    await saveSession(session);
  });
}

async function settlePrompt(
  surfaceId: string,
  runId: string,
  result: unknown,
  error?: unknown,
): Promise<void> {
  await withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    const run = session?.recentRuns.find((candidate) => candidate.id === runId);
    if (!session || !run || run.outcome !== 'running') return;
    let settlementError = error;
    let stopReason = 'error';
    if (!settlementError) {
      try {
        stopReason = validateDeepSeekHarnessPrompt(result).stopReason;
      } catch (validationError) {
        settlementError = validationError;
      }
    }
    run.finishReason = stopReason;
    run.finishedAt = nowIso();
    run.outcome = settlementError
      ? 'failed'
      : stopReason === 'cancelled'
        ? 'interrupted'
        : 'finished';
    await appendFile(run.stdoutPath, `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'o8/session.prompt.settled',
      params: { outcome: run.outcome, stopReason },
    })}\n`, 'utf8');
    const parsed = parseDeepSeekHarnessRunLog(
      await readFile(run.stdoutPath, 'utf8').catch(() => ''),
      run,
    );
    session.latestSummary = settlementError
      ? compactText(settlementError instanceof Error ? settlementError.message : String(settlementError), 2_000)
      : parsed.entries.filter((entry) => entry.kind === 'message').at(-1)?.text
        ?? `DeepSeek Harness turn ${run.outcome}.`;
    replaceRun(session, run);
    session.activeRun = run;
    await saveSession(session);
  });
}

async function recordProcessExit(surfaceId: string, process: ActiveHarnessProcess): Promise<void> {
  if (activeProcesses.get(surfaceId)?.peer !== process.peer) return;
  activeProcesses.delete(surfaceId);
  await withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    if (!session) return;
    session.rpcPid = undefined;
    const run = session.activeRun;
    if (run) {
      if (run.outcome === 'running') {
        run.outcome = 'failed';
        run.finishedAt = nowIso();
        replaceRun(session, run);
        session.latestSummary = 'DeepSeek Harness runtime exited before the active turn settled.';
      }
      session.activeRun = undefined;
    }
    await saveSession(session);
  });
}

async function ensureProcess(session: DeepSeekHarnessSessionRecord): Promise<ActiveHarnessProcess> {
  const existing = activeProcesses.get(session.surfaceId);
  if (existing?.peer.running) return existing;
  const launch = await resolveDeepSeekHarnessLaunch({ model: session.model });
  const peer = new StdioJsonRpcPeer({
    command: launch.command,
    args: launch.args,
    cwd: session.repoPath,
    env: {
      ...process.env,
      DSH_SNAPSHOT_SESSIONS_ROOT: path.join(session.sessionDir, 'harness-sessions'),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  }, 30_000);
  const activeProcess: ActiveHarnessProcess = { peer, sessionId: '' };
  activeProcesses.set(session.surfaceId, activeProcess);
  peer.on('notification', (notification: StdioJsonRpcNotification) => {
    void handleNotification(session.surfaceId, notification).catch((error) => {
      console.error('[deepseek-harness] notification persistence failed', error);
    });
  });
  peer.on('request', (request: StdioJsonRpcInboundRequest) => {
    handleAcpRequest(peer, request);
  });
  peer.on('stderr', (chunk: Buffer) => {
    void withSession(session.surfaceId, async () => {
      const current = await findSession(session.surfaceId, false);
      if (current?.activeRun) await appendFile(current.activeRun.stderrPath, chunk);
    });
  });
  peer.on('exit', () => { void recordProcessExit(session.surfaceId, activeProcess); });
  try {
    const initialized = validateDeepSeekHarnessInitialize(await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'o8', version: '0.1.0' },
    }));
    const created = validateDeepSeekHarnessNewSession(await peer.request('session/new', {
      cwd: session.repoPath,
      mcpServers: [],
    }));
    activeProcess.sessionId = created.sessionId;
    await withSession(session.surfaceId, async () => {
      const current = await findSession(session.surfaceId, false);
      if (!current) return;
      current.sessionId = created.sessionId;
      current.rpcPid = peer.pid;
      current.commandIdentity = path.basename(launch.command);
      current.serverVersion = initialized.agentInfo.version;
      if (current.activeRun) {
        current.activeRun.pid = peer.pid;
        current.activeRun.commandIdentity = current.commandIdentity;
        replaceRun(current, current.activeRun);
      }
      await saveSession(current);
    });
    return activeProcess;
  } catch (error) {
    activeProcesses.delete(session.surfaceId);
    await peer.close().catch(() => {});
    throw error;
  }
}

async function createRun(
  surfaceId: string,
  prompt: string,
  mode: 'launch' | 'resume',
): Promise<DeepSeekHarnessRunRecord> {
  return withSession(surfaceId, async () => {
    const session = await findSession(surfaceId, false);
    if (!session) throw new Error('Owned DeepSeek Harness session was not found.');
    if (session.activeRun?.outcome === 'running') {
      throw new Error('This DeepSeek Harness session still has an active turn.');
    }
    await ensureDir(path.join(session.sessionDir, RUNS_DIR));
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const run: DeepSeekHarnessRunRecord = {
      id,
      mode,
      prompt,
      startedAt: nowIso(),
      outcome: 'running',
      stdoutPath: path.join(session.sessionDir, RUNS_DIR, `${id}.jsonl`),
      stderrPath: path.join(session.sessionDir, RUNS_DIR, `${id}.stderr.log`),
      pid: session.rpcPid,
      commandIdentity: session.commandIdentity,
    };
    session.latestPrompt = prompt;
    session.latestSummary = compactText(prompt, 140);
    session.reviewDisposition = 'watching';
    session.reviewDispositionUpdatedAt = nowIso();
    session.activeRun = run;
    session.recentRuns = [run, ...session.recentRuns].slice(0, 32);
    await saveSession(session);
    return run;
  });
}

async function dispatchPrompt(
  surfaceId: string,
  prompt: string,
  mode: 'launch' | 'resume',
): Promise<{ ok: boolean; note: string; sideEffect?: 'none' | 'unknown' }> {
  if (mode === 'resume' && !activeProcesses.get(surfaceId)?.peer.running) {
    return {
      ok: false,
      sideEffect: 'none',
      note: 'The official Harness ACP preview cannot reload a session after its owning process exits; launch a new Harness session instead.',
    };
  }
  const run = await createRun(surfaceId, prompt, mode);
  let process: ActiveHarnessProcess;
  try {
    const session = await findSession(surfaceId, false);
    if (!session) throw new Error('Owned DeepSeek Harness session was not found.');
    process = await ensureProcess(session);
  } catch (error) {
    await withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      if (!session) return;
      run.outcome = 'failed';
      run.finishedAt = nowIso();
      replaceRun(session, run);
      session.activeRun = undefined;
      session.latestSummary = error instanceof Error ? error.message : String(error);
      await saveSession(session);
    });
    return { ok: false, sideEffect: 'none', note: error instanceof Error ? error.message : String(error) };
  }

  void process.peer.request('session/prompt', {
    sessionId: process.sessionId,
    prompt: [{ type: 'text', text: prompt }],
  }, TURN_TIMEOUT_MS).then(
    (result) => settlePrompt(surfaceId, run.id, result),
    (error) => settlePrompt(surfaceId, run.id, null, error),
  ).catch((error) => {
    console.error('[deepseek-harness] prompt settlement persistence failed', error);
  });
  return { ok: true, note: mode === 'launch'
    ? 'DeepSeek Harness accepted the first turn over its official ACP process.'
    : 'DeepSeek Harness accepted the follow-up on the same live ACP session.' };
}

export async function launchOwnedDeepSeekHarnessSession(request: {
  cwd: string;
  prompt: string;
  clientMutationId?: string;
  model?: string;
  laneId?: string;
  packetId?: string;
}) {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error('prompt is required');
  const repoPath = await validateWorkspace(request.cwd);
  const repo = await resolveRepoContext(repoPath);
  const id = `${SESSION_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`;
  const sessionDir = path.join(root(), id);
  await mkdir(sessionDir, { recursive: true });
  const session: DeepSeekHarnessSessionRecord = {
    surfaceId: `${SURFACE_PREFIX}${id}`,
    launchMutationId: request.clientMutationId?.trim() || undefined,
    laneId: request.laneId?.trim() || undefined,
    packetId: request.packetId?.trim() || undefined,
    sessionDir,
    cwd: repoPath,
    repoPath,
    repoSlug: repo.repoSlug,
    branch: repo.branch,
    head: repo.head,
    title: repo.title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    sessionId: id,
    latestPrompt: prompt,
    latestSummary: compactText(prompt, 140),
    model: request.model?.trim() || DEFAULT_MODEL,
    reviewDisposition: 'watching',
    reviewDispositionUpdatedAt: nowIso(),
    recentRuns: [],
  };
  await saveSession(session);
  const result = await dispatchPrompt(session.surfaceId, prompt, 'launch');
  return {
    ok: result.ok,
    runtime: 'deepseek-harness' as const,
    surfaceId: session.surfaceId,
    note: result.note,
    sideEffect: result.sideEffect,
  };
}

export async function continueOwnedDeepSeekHarnessSession(surfaceId: string, message: string) {
  const prompt = message.trim();
  if (!prompt) return { ok: false, note: 'message is required', sideEffect: 'none' as const };
  return dispatchPrompt(surfaceId, prompt, 'resume');
}

export async function interruptOwnedDeepSeekHarnessSession(surfaceId: string) {
  const session = await findSession(surfaceId, false);
  if (!session) throw new Error('Owned DeepSeek Harness session was not found.');
  const active = activeProcesses.get(surfaceId);
  if (active) {
    if (session.activeRun?.outcome === 'running') {
      active.peer.notify('session/cancel', { sessionId: active.sessionId });
    }
    await withSession(surfaceId, async () => {
      const current = await findSession(surfaceId, false);
      if (!current) return;
      const run = current.activeRun;
      if (run?.outcome === 'running') {
        run.outcome = 'interrupted';
        run.finishedAt = nowIso();
        replaceRun(current, run);
      }
      current.activeRun = undefined;
      await saveSession(current);
    });
    activeProcesses.delete(surfaceId);
    await active.peer.close();
  } else if (session.rpcPid && isPidAlive(session.rpcPid)) {
    const commandLine = await pidCommandLine(session.rpcPid);
    if (!session.commandIdentity || !commandLine?.includes(session.commandIdentity)) {
      return { interrupted: false, note: 'The persisted Harness PID no longer matches its recorded executable; no signal was sent.' };
    }
    const killed = await escalateInterrupt({ pid: session.rpcPid, commandLabel: session.commandIdentity });
    if (!killed.confirmedDead && !killed.alreadyDead) return { interrupted: false, note: killed.note };
  }
  await withSession(surfaceId, async () => {
    const current = await findSession(surfaceId, false);
    if (!current) return;
    const run = current.activeRun;
    if (run?.outcome === 'running') {
      run.outcome = 'interrupted';
      run.finishedAt = nowIso();
      replaceRun(current, run);
    }
    current.activeRun = undefined;
    current.rpcPid = undefined;
    await saveSession(current);
  });
  return { interrupted: true, note: 'The owned DeepSeek Harness ACP process was stopped. This preview cannot reload that session after process exit.' };
}

function buildSurface(session: DeepSeekHarnessSessionRecord): RuntimeSurfaceSummary {
  const running = session.activeRun?.outcome === 'running';
  const liveProcess = activeProcesses.get(session.surfaceId)?.peer.running === true;
  const latest = session.recentRuns[0];
  return {
    id: session.surfaceId,
    runtime: 'deepseek-harness',
    kind: 'runtime-session',
    ownership: 'owned',
    title: session.title,
    cwd: session.repoPath.replace(os.homedir(), '~'),
    branch: session.branch,
    sourceLabel: running
      ? `Owned DeepSeek Harness ACP • active pid ${session.activeRun?.pid ?? session.rpcPid ?? 'starting'}`
      : `Owned DeepSeek Harness ACP • ${session.serverVersion ?? 'ready'}`,
    tailSourceLabel: `${session.sessionDir}/${RUNS_DIR}/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: !running && liveProcess,
      interrupt: running || Boolean(session.rpcPid),
      resize: false,
      diffContext: Boolean(session.branch || session.repoSlug),
      reviewContext: Boolean(session.branch || session.repoSlug),
    },
    lifecycle: {
      availability: running ? 'running' : 'ready-for-resume',
      lastOutcome: latest?.outcome === 'running' ? undefined : latest?.outcome,
      lastRunMode: latest?.mode,
      lastRunStartedAt: latest?.startedAt,
      lastRunFinishedAt: latest?.finishedAt,
      summary: running
        ? 'A DeepSeek Harness turn is running over the owned ACP process.'
        : liveProcess
          ? 'The live ACP session is ready for a follow-up turn.'
          : 'The ACP preview process exited and cannot reload this session; launch a new session to continue.',
    },
    reviewContext: { repoSlug: session.repoSlug, branch: session.branch, head: session.head },
  };
}

async function tailForSession(session: DeepSeekHarnessSessionRecord) {
  const entries: OwnedTailEntry[] = [];
  const groups: OwnedTailGroup[] = [];
  for (const run of [...session.recentRuns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const parsed = parseDeepSeekHarnessRunLog(await readFile(run.stdoutPath, 'utf8').catch(() => ''), run);
    entries.push(...parsed.entries);
    groups.push({
      id: run.id,
      title: `${run.mode === 'launch' ? 'Harness launch turn' : 'Harness follow-up turn'} • ${run.outcome}`,
      mode: run.mode,
      outcome: run.outcome,
      prompt: compactText(run.prompt, 8_000),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startedAtLabel: formatClock(run.startedAt),
      finishedAtLabel: formatClock(run.finishedAt),
      summary: parsed.entries.at(-1)?.text ?? session.latestSummary,
      entries: parsed.entries,
    });
  }
  return { surface: buildSurface(session), entries, groups };
}

export async function getOwnedDeepSeekHarnessRuntimeTail(surfaceId: string) {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned DeepSeek Harness session was not found.');
  return tailForSession(session);
}

export async function getOwnedDeepSeekHarnessFleetAdditions(): Promise<{
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  ownedThreadIds: string[];
  sourceLabel: string;
}> {
  const sessions = (await Promise.all((await listDirs()).map(loadSession)))
    .filter((session): session is DeepSeekHarnessSessionRecord => Boolean(session));
  const agents: AgentSummary[] = sessions.map((session) => ({
    id: session.surfaceId,
    name: session.title,
    squadId: 'squad-deepseek-harness-owned',
    runtime: 'deepseek-harness',
    model: session.model,
    status: session.activeRun?.outcome === 'running' ? 'running' : 'reviewing',
    currentTask: session.latestSummary,
    workspace: session.repoPath,
    branch: session.branch ?? '',
    sessionKey: session.surfaceId,
    sessionId: session.sessionId,
    approvalStatus: 'none',
    lastEventAt: session.updatedAt,
    context: { usedPercent: 0, trend: 'stable' },
    alerts: 0,
    runtimeSurface: buildSurface(session),
  }));
  return {
    agents,
    squads: [{
      id: 'squad-deepseek-harness-owned',
      name: 'DeepSeek Harness Owned',
      status: agents.some((agent) => agent.status === 'running') ? 'watching' : 'healthy',
      throughputLabel: `${agents.length} Harness session${agents.length === 1 ? '' : 's'}`,
      blockers: 0,
      alerts: 0,
      liveSessions: agents.filter((agent) => agent.status === 'running').length,
      members: agents.map((agent) => agent.id),
    }],
    events: [],
    artifacts: [],
    ownedThreadIds: sessions.map((session) => session.sessionId),
    sourceLabel: 'Owned DeepSeek Harness ACP sessions',
  };
}

export async function getOwnedDeepSeekHarnessReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket> {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned DeepSeek Harness session was not found.');
  const review = await getRuntimeRepoReview(session.repoPath);
  const latest = session.recentRuns[0];
  return {
    surfaceId,
    runtime: 'deepseek-harness',
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
    notes: [
      `Protocol server: ${DEEPSEEK_HARNESS_SERVER_NAME}`,
      session.serverVersion ? `Runtime version: ${session.serverVersion}` : 'Runtime version has not been observed yet.',
    ],
  };
}

export async function getOwnedDeepSeekHarnessTelemetrySources(surfaceId: string) {
  const session = await findSession(surfaceId);
  if (!session) return null;
  return {
    threadId: session.sessionId,
    stdoutPaths: [...session.recentRuns].reverse().map((run) => run.stdoutPath),
  };
}

export async function setOwnedDeepSeekHarnessReviewDisposition(
  surfaceId: string,
  disposition: 'watching' | 'resolved',
) {
  const session = await findSession(surfaceId);
  if (!session) throw new Error('Owned DeepSeek Harness session was not found.');
  session.reviewDisposition = disposition;
  session.reviewDispositionUpdatedAt = nowIso();
  await saveSession(session);
  return { disposition, note: disposition === 'resolved' ? 'Marked Harness result resolved.' : 'Watching Harness result.' };
}

export async function archiveOwnedDeepSeekHarnessSession(surfaceId: string) {
  const session = await findSession(surfaceId, false);
  if (!session) {
    const archived = await archivedSessionPathForSurfaceId(root(), surfaceId, SURFACE_PREFIX);
    return archived
      ? { archived: true, archivePath: archived, note: 'Session already archived.' }
      : { archived: false, note: 'Owned DeepSeek Harness session was not found.' };
  }
  const stopped = await interruptOwnedDeepSeekHarnessSession(surfaceId);
  if (!stopped.interrupted) return { archived: false, note: stopped.note };
  const latest = await findSession(surfaceId, false);
  if (!latest) return { archived: false, note: 'Session disappeared before archive.' };
  return archiveOwnedSessionDir(root(), latest as unknown as OwnedSessionRecord);
}

export function ownedDeepSeekHarnessSessionState(surfaceId: string) {
  return readOwnedSessionState(root(), surfaceId, SURFACE_PREFIX);
}

export function invalidateOwnedDeepSeekHarnessFleetCache(): void {
  // This adapter reads durable state directly and keeps no fleet cache.
}

registerOwnedSessionLifecycleHandler({
  runtimeId: 'deepseek-harness',
  surfaceIdPrefix: SURFACE_PREFIX,
  commandLabel: 'dsh-acp-demo',
  resolveRoot: root,
  sessionState: ownedDeepSeekHarnessSessionState,
  archiveSession: archiveOwnedDeepSeekHarnessSession,
});
