import os from 'node:os';
import path from 'node:path';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import type { OwnedRuntimeAdapter, OwnedRunRecord, OwnedSessionRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';
import { getDataDir } from '@/lib/data-dir-migration';
import { museRecord } from './protocol';
import { captureMuseRuntimeConfig, museRoot } from './roots';
import type { ResolvedWorkerMcpServer } from '@/lib/mcp/worker-injection';

export function museWorkerArgs(ctx: { prompt: string; model?: string; effort?: string; threadId?: string; runtimeConfig?: Record<string, string>; workerMcpServers?: ResolvedWorkerMcpServer[] }): string[] {
  const args = ['exec', '--json', '--provider', 'meta', '--disable-approval', '--approval-judge', 'off', '--max-model-steps', '40'];
  if (ctx.runtimeConfig?.workMode === 'read-only') args.push('--disable-shell', '--disable-write');
  for (const server of ctx.workerMcpServers ?? []) {
    if (!/^[a-zA-Z0-9_-]+$/.test(server.name)) throw new Error('Muse tool server names must use letters, numbers, underscores or hyphens.');
    args.push('-c', `mcp_servers.${server.name}=${JSON.stringify({ command: server.command, args: server.args,
      env: server.env ?? {}, transport: 'stdio', enabled: true, mode: 'required' })}`);
  }
  if (ctx.threadId) args.push('--session-id', ctx.threadId);
  if (ctx.model) args.push('--model', ctx.model);
  if (ctx.effort && ctx.effort !== 'adaptive') args.push('--reasoning-effort', ctx.effort);
  return [...args, ctx.prompt];
}

export function museWorkerEnvironment(session: OwnedSessionRecord): Record<string, string> {
  if (!session.runtimeConfig?.museConfigRoot || !session.runtimeConfig.museDataRoot) throw new Error('Muse account roots are missing. Start a new session; this conversation was preserved.');
  return { XDG_CONFIG_HOME: museRoot(session.identity?.configHomeRef ?? session.runtimeConfig.museConfigRoot, true, session.cwd),
    XDG_DATA_HOME: museRoot(session.runtimeConfig.museDataRoot, true, session.cwd),
    META_API_KEY: '', META_API_URL: '', META_BASE_URL: '', MUSE_AUTH_PATH: '', OPENROUTER_API_KEY: '',
    NODE_OPTIONS: '', MUSE_PERMISSION_PROFILE_FAIL_OPEN: '', MUSE_NO_AUTO_UPDATE: '1' };
}

/** Native exec emits durable journal envelopes, not MSP view notifications. */
export function parseMuseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  const entries: OwnedTailEntry[] = [{ id: `${run.id}:prompt`, kind: 'event', label: 'Prompt', text: compactText(run.prompt, 400),
    timestamp: run.startedAt, timestampLabel: formatClock(run.startedAt) }];
  let threadId: string | undefined;
  let rootRun: string | undefined;
  let answer = '';
  let completedTurn = false;
  let providerFailure: ParsedRunLog['providerFailure'];
  for (const [index, line] of raw.split('\n').entries()) {
    let frame: Record<string, unknown>;
    try { frame = museRecord(JSON.parse(line)); } catch { continue; }
    if (frame.schema_version !== 1) continue;
    const stream = museRecord(frame.stream);
    if (stream.kind === 'session' && typeof stream.id === 'string') threadId ??= stream.id;
    if (stream.id !== threadId) continue;
    const payload = museRecord(frame.payload);
    const type = String(frame.payload_type ?? '');
    const runStream = museRecord(payload.run_stream);
    if (type === 'session.run.linked' && typeof runStream.id === 'string') rootRun ??= runStream.id;
    if (rootRun && runStream.id && runStream.id !== rootRun) continue;
    if (type === 'run.output.delta' && typeof payload.delta === 'string') answer += payload.delta;
    if (type.startsWith('run.terminal.') && frame.durability === 'durable') {
      completedTurn = payload.terminal === 'completed' && !payload.failure_kind && !payload.failureKind;
      if (!completedTurn) providerFailure = { subtype: String(payload.terminal ?? 'unknown'), message: 'Muse did not complete this worker turn.' };
      if (typeof payload.text === 'string') answer = payload.text;
    }
    if (type.includes('tool') && !type.includes('task.lifecycle')) {
      entries.push({ id: `${run.id}:tool:${index}`, kind: type.includes('result') || type.includes('completed') ? 'tool-output' : 'tool',
        label: String(payload.tool_name ?? payload.tool ?? type), text: compactText(String(payload.text ?? payload.output ?? payload.arguments ?? payload.args ?? ''), 2_000),
        timestamp: run.finishedAt ?? run.startedAt, timestampLabel: formatClock(run.finishedAt ?? run.startedAt) });
    }
  }
  if (answer) entries.push({ id: `${run.id}:answer`, kind: 'message', label: 'Muse Code', text: answer,
    timestamp: run.finishedAt ?? run.startedAt, timestampLabel: formatClock(run.finishedAt ?? run.startedAt) });
  return { entries, threadId, completedTurn, providerFailure,
    outcome: providerFailure ? 'failed' : completedTurn ? 'finished' : run.outcome === 'running' ? 'running' : 'failed' };
}

export const museOwnedAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'muse', surfaceIdPrefix: 'muse-owned:', sessionIdPrefix: 'muse-owned-',
  rootEnvVar: 'O8_OWNED_MUSE_ROOT', rootDefault: path.join(getDataDir(), 'owned-muse'),
  binaryName: 'muse', binaryEnvOverride: 'O8_MUSE_BIN', humanLabel: 'Owned Muse Code', squadShortName: 'Muse',
  isolatedConfigHomeEnv: 'XDG_CONFIG_HOME', configStateSubdir: 'muse',
  sessionDataHomeEnv: 'XDG_DATA_HOME', sessionDataSubdir: 'muse',
  workerMcpInjection: 'config-override',
  defaultConfigHome: () => museRoot(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')),
  captureRuntimeConfig: captureMuseRuntimeConfig,
  extraSpawnEnv: museWorkerEnvironment,
  launchArgs: museWorkerArgs,
  resumeArgs: museWorkerArgs,
  parseRunLog: parseMuseRunLog,
};

export const museOwnedStore = createOwnedSessionStore(museOwnedAdapter);
