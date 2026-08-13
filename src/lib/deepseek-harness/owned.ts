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
  type StdioJsonRpcNotification,
} from '@/lib/runtimes/shared/stdio-json-rpc';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import {
  DEEPSEEK_HARNESS_SERVER_NAME,
  deepSeekHarnessEvent,
  deepSeekHarnessInboxContains,
  parseDeepSeekHarnessRunLog,
  type DeepSeekHarnessRunRecord,
  validateDeepSeekHarnessInitialize,
  validateDeepSeekHarnessPrompt,
} from './protocol';
import { resolveDeepSeekHarnessLaunch } from './runtime-resolution';

const SURFACE_PREFIX = 'deepseek-harness-owned:';
const SESSION_PREFIX = 'deepseek-harness-owned-';
const RUNS_DIR = 'runs';
const DEFAULT_MODEL = 'deepseek-v4-flash';

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

async function finishRunIfReady(session: DeepSeekHarnessSessionRecord, run: DeepSeekHarnessRunRecord): Promise<void> {
  if (!run.inboxAccepted || !run.idleSeen || run.outcome !== 'running') return;
  const parsed = parseDeepSeekHarnessRunLog(
    await readFile(run.stdoutPath, 'utf8').catch(() => ''),
    run,
  );
  run.finishReason = run.finishReason ?? parsed.finishReason;
  run.finishedAt = nowIso();
  run.outcome = run.finishReason === 'error'
    ? 'failed'
    : run.finishReason === 'interrupted' || run.finishReason === 'aborted'
      ? 'interrupted'
      : 'finished';
  session.latestSummary = parsed.entries
    .filter((entry) => entry.kind === 'message')
    .at(-1)?.text ?? `DeepSeek Harness turn ${run.outcome}.`;
  replaceRun(session, run);
  // The Harness process stays alive between turns. Keep the settled run as the
  // process anchor so the shared liveness and confirmed-kill paths still see
  // its pid while the UI correctly treats a non-running outcome as idle.
  session.activeRun = run;
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

    if (notification.method === 'session.event') {
      const event = deepSeekHarnessEvent(notification.params);
      if (event?.type === 'agent/inbox/spliced') {
        const inserted = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>).inserted
          : null;
        const firstId = Array.isArray(inserted)
          ? inserted.map((item) => item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>).id
            : null).find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          : null;
        if (firstId) {
          run.messageId = run.messageId ?? firstId;
          run.inboxAccepted = deepSeekHarnessInboxContains(event, run.messageId);
        }
      }
      if (event?.type === 'turn/end') {
        const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? event.data as Record<string, unknown>
          : null;
        const reason = data?.reason && typeof data.reason === 'object' && !Array.isArray(data.reason)
          ? data.reason as Record<string, unknown>
          : null;
        run.finishReason = typeof reason?.kind === 'string' ? reason.kind : 'unknown';
      }
    }
    if (notification.method === 'session.status'
      && notification.params.sessionId === session.sessionId
      && notification.params.status === 'idle') {
      run.idleSeen = true;
    }
    await finishRunIfReady(session, run);
    replaceRun(session, run);
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
  const launch = await resolveDeepSeekHarnessLaunch();
  const peer = new StdioJsonRpcPeer({
    command: launch.command,
    args: launch.args,
    cwd: session.repoPath,
    env: {
      ...process.env,
      DSH_CWD: session.repoPath,
      DSH_SESSION_ROOT: path.join(session.sessionDir, 'harness-sessions'),
      ...(launch.configPath ? { DSH_CORDIS_CONFIG: launch.configPath } : {}),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  }, 30_000);
  const activeProcess: ActiveHarnessProcess = { peer, sessionId: session.sessionId };
  activeProcesses.set(session.surfaceId, activeProcess);
  peer.on('notification', (notification: StdioJsonRpcNotification) => {
    void handleNotification(session.surfaceId, notification).catch((error) => {
      console.error('[deepseek-harness] notification persistence failed', error);
    });
  });
  peer.on('request', (request: { id: string | number; method: string }) => {
    peer.respondError(request.id, -32601, `o8 has no handler for runtime request ${request.method}.`);
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
      cwd: session.repoPath,
      provider: globalThis.process.env.O8_DEEPSEEK_HARNESS_PROVIDER?.trim() || 'deepseek-official',
      model: session.model,
    }));
    await withSession(session.surfaceId, async () => {
      const current = await findSession(session.surfaceId, false);
      if (!current) return;
      current.rpcPid = peer.pid;
      current.commandIdentity = path.basename(launch.command);
      current.serverVersion = initialized.serverInfo.version;
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

  try {
    const receipt = validateDeepSeekHarnessPrompt(await process.peer.request('session/prompt', {
      sessionId: process.sessionId,
      contentBlocks: [{ type: 'text', text: prompt }],
    }));
    await withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      const active = session?.activeRun;
      if (!session || !active || active.id !== run.id) return;
      if (active.messageId && active.messageId !== receipt.messageId) {
        throw new Error('DeepSeek Harness prompt receipt did not match the durable inbox event.');
      }
      active.messageId = receipt.messageId;
      active.inboxAccepted = true;
      await finishRunIfReady(session, active);
      replaceRun(session, active);
      await saveSession(session);
    });
    return { ok: true, note: mode === 'launch'
      ? 'DeepSeek Harness accepted the first turn over its persistent JSON-RPC process.'
      : 'DeepSeek Harness accepted the follow-up on the same owned session.' };
  } catch (error) {
    const note = `DeepSeek Harness may have accepted the turn, but o8 could not settle its receipt: ${error instanceof Error ? error.message : String(error)}`;
    await withSession(surfaceId, async () => {
      const session = await findSession(surfaceId, false);
      if (!session) return;
      session.latestSummary = note;
      await saveSession(session);
    });
    return { ok: false, sideEffect: 'unknown', note };
  }
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
    if (run) {
      run.outcome = 'interrupted';
      run.finishedAt = nowIso();
      replaceRun(current, run);
      current.activeRun = undefined;
    }
    current.rpcPid = undefined;
    await saveSession(current);
  });
  return { interrupted: true, note: 'The owned DeepSeek Harness process was stopped; the durable session can be resumed in a fresh process.' };
}

function buildSurface(session: DeepSeekHarnessSessionRecord): RuntimeSurfaceSummary {
  const running = session.activeRun?.outcome === 'running';
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
      ? `Owned DeepSeek Harness JSON-RPC • active pid ${session.activeRun?.pid ?? session.rpcPid ?? 'starting'}`
      : `Owned DeepSeek Harness JSON-RPC • ${session.serverVersion ?? 'ready'}`,
    tailSourceLabel: `${session.sessionDir}/${RUNS_DIR}/*.jsonl`,
    capabilities: {
      attach: true,
      readTail: true,
      sendInput: !running,
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
        ? 'A DeepSeek Harness turn is running over the owned JSON-RPC process.'
        : 'The durable Harness session is ready for a follow-up turn.',
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
    sourceLabel: 'Owned DeepSeek Harness JSON-RPC sessions',
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
  commandLabel: 'dsh-jsonrpc-agent',
  resolveRoot: root,
  sessionState: ownedDeepSeekHarnessSessionState,
  archiveSession: archiveOwnedDeepSeekHarnessSession,
});
