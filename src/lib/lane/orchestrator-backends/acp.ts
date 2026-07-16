/**
 * Generic ACP orchestrator backend.
 *
 * Drives ANY Agent-Client-Protocol agent (agentclientprotocol.com) as an o8
 * orchestrator backend, on top of `@/lib/acp/client`. Parameterized by launch
 * command, so Hermes (`hermes acp`) is just the first agent — openclaw acpx /
 * Zed / any ACP agent ride the same backend via a different launch config.
 *
 * Session model: one long-lived agent subprocess (an AcpClient) per
 * repo+thread, reused across turns (the ACP `sessionId` persists the
 * conversation). The handshake (initialize → session/new, injecting o8's
 * operator MCP server) runs lazily on the first turn; subsequent turns are just
 * `session/prompt`. Abort SIGTERM-cancels the in-flight turn; a watchdog kills a
 * hung subprocess. Mirrors openclaw's lifecycle realtime-publish for mobile.
 *
 * The #1075 orchestrator≠worker lockout is enforced separately by the governed
 * profile (`governHermesProfile`) — an ACP client can't strip an agent's native
 * tools, so Hermes runs against a profile that denies native spawn.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { AcpClient, mapStopReason, type AcpMcpServer } from '@/lib/acp/client';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import { governHermesProfile } from './hermes-profile';
import type {
  OrchestratorBackend,
  OrchestratorBackendId,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/** Hang watchdog (not a work budget) — mirrors the other backends' 4h ceiling. */
const ACP_PROCESS_TIMEOUT_MS = 14_400_000;

interface AcpSession {
  key: string;
  sessionName: string;
  repoPath: string;
  client: AcpClient;
  sessionId: string | null;
  status: 'ready' | 'busy' | 'dead';
  createdAt: number;
  /** The current turn's event sink — set by sendTurn, cleared on completion. */
  onEvent?: (event: OrchestratorEvent) => void;
}

const sessions = new Map<string, AcpSession>();
let acpRealtimeSeq = 0;

function sessionKey(backendId: string, repoPath: string, threadId?: string | null): string {
  return `${backendId}::${repoPath}::${threadId ?? 'default'}`;
}

/** o8's operator MCP server in ACP's session/new shape (env as {name,value}[]). */
function o8McpServersForAcp(repoPath: string): AcpMcpServer[] {
  try {
    const o8 = toOpenclawJson(buildToolRegistry(repoPath)).servers['o8'] as
      | { command: string; args: string[]; env?: Record<string, string> }
      | undefined;
    if (!o8) return [];
    return [{
      name: 'o8',
      command: o8.command,
      args: o8.args,
      env: Object.entries(o8.env ?? {}).map(([name, value]) => ({ name, value })),
    }];
  } catch {
    return [];
  }
}

function publishAcpLifecycle(backendId: string, session: AcpSession, event: OrchestratorEvent): void {
  const base = { backendId, threadKey: session.key };
  const realtime = event.type === 'text'
    ? { event: 'output' as const, action: 'orchestrator-output', status: 'completed' as const, note: `${backendId} assistant output (${event.text.length} chars)`, data: { ...base, text: event.text, thinking: false } }
    : event.type === 'error'
      ? { event: 'error' as const, action: 'orchestrator-error', status: 'failed' as const, note: event.error.slice(0, 240), data: { ...base, error: event.error } }
      : event.type === 'done'
        ? { event: 'status' as const, action: 'orchestrator-status', status: 'completed' as const, note: `${backendId} orchestrator turn completed`, data: { ...base, status: 'ready' as const, sessionId: event.sessionId, cost: event.cost } }
        : null;
  if (!realtime) return;
  const createdAt = new Date().toISOString();
  const mutation = {
    mutationId: `${backendId}-${realtime.event}-${Date.now()}-${acpRealtimeSeq += 1}`,
    source: 'server',
    action: realtime.action,
    status: realtime.status,
    runtime: backendId,
    surfaceId: session.sessionName,
    sessionKey: session.sessionName,
    repoPath: session.repoPath,
    note: realtime.note,
    createdAt,
    settledAt: createdAt,
    channel: 'orchestrator',
    event: realtime.event,
    data: realtime.data,
  } as RealtimeMutationRecord;
  void publishRealtimeMutation({ mutation, fresh: true });
}

export interface AcpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AcpBackendConfig {
  id: OrchestratorBackendId;
  label: string;
  /** Resolve the launch command; null when the agent isn't available/configured. */
  resolveLaunch: (repoPath: string) => AcpLaunch | null;
}

export function makeAcpBackend(config: AcpBackendConfig): OrchestratorBackend {
  const { id, label } = config;

  function spawnSession(repoPath: string, threadId?: string | null): AcpSession {
    const launch = config.resolveLaunch(repoPath);
    if (!launch) throw new Error(`${label} (ACP) is not available — its agent binary/profile could not be resolved.`);
    const key = sessionKey(id, repoPath, threadId);
    const session: AcpSession = {
      key,
      sessionName: key,
      repoPath,
      sessionId: null,
      status: 'ready',
      createdAt: Date.now(),
      client: new AcpClient({
        command: launch.command,
        args: launch.args,
        env: launch.env,
        onEvent: (event) => session.onEvent?.(event),
      }),
    };
    sessions.set(key, session);
    return session;
  }

  function ensureSync(repoPath: string, threadId?: string | null): AcpSession {
    const key = sessionKey(id, repoPath, threadId);
    const existing = sessions.get(key);
    if (existing && existing.status !== 'dead' && existing.client.alive) return existing;
    if (existing) sessions.delete(key);
    return spawnSession(repoPath, threadId);
  }

  async function ensureHandshake(session: AcpSession): Promise<string> {
    if (session.sessionId) return session.sessionId;
    await session.client.initialize();
    session.sessionId = await session.client.newSession(session.repoPath, o8McpServersForAcp(session.repoPath));
    return session.sessionId;
  }

  return {
    id,
    label,
    peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
      const session = sessions.get(sessionKey(id, repoPath, threadId));
      return session && session.client.alive ? { sessionName: session.sessionName, status: session.status } : null;
    },
    ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
      const session = ensureSync(repoPath, threadId);
      return { sessionName: session.sessionName, status: session.status };
    },
    async sendTurn(repoPath, message, onEvent, options?: OrchestratorTurnOptions): Promise<void> {
      const session = ensureSync(repoPath, options?.threadId);
      session.status = 'busy';
      session.onEvent = onEvent;

      const watchdog = setTimeout(() => {
        session.status = 'dead';
        session.client.kill();
      }, ACP_PROCESS_TIMEOUT_MS);

      const onAbort = () => {
        if (session.sessionId) session.client.cancel(session.sessionId);
      };
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const sessionId = await ensureHandshake(session);
        const stopReason = await session.client.prompt(sessionId, message);
        const doneOrError = mapStopReason(stopReason, sessionId);
        onEvent(doneOrError);
        publishAcpLifecycle(id, session, doneOrError);
      } catch (err) {
        const errorEvent: OrchestratorEvent = { type: 'error', error: err instanceof Error ? err.message : String(err) };
        onEvent(errorEvent);
        publishAcpLifecycle(id, session, errorEvent);
        session.status = 'dead';
        session.client.kill();
      } finally {
        clearTimeout(watchdog);
        options?.signal?.removeEventListener('abort', onAbort);
        session.onEvent = undefined;
        if (session.status !== 'dead') session.status = 'ready';
      }
    },
  };
}

// ── Concrete backends ──────────────────────────────────────────────────────────

/** Resolve the `hermes` binary (PATH); null when not installed. */
function resolveHermesBinary(): string | null {
  for (const candidate of [
    process.env.O8_HERMES_BIN,
    `${process.env.HOME ?? ''}/.local/bin/hermes`,
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
    `${process.env.HOME ?? ''}/.npm-global/bin/hermes`,
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Hermes via `hermes acp`, run against the GOVERNED profile (3d): an isolated
 * HOME whose config denies Hermes's native work toolsets (delegation = the
 * native spawn, terminal/file/code_execution/browser/computer_use) so the
 * orchestrator can only dispatch through o8. SAFETY INTERLOCK: if the profile
 * can't be governed, resolveLaunch throws — Hermes NEVER runs ungoverned.
 */
export const hermesBackend: OrchestratorBackend = makeAcpBackend({
  id: 'hermes',
  label: 'Hermes',
  resolveLaunch: () => {
    const bin = resolveHermesBinary();
    if (!bin) return null;
    const governed = governHermesProfile(bin);
    if (!governed) {
      throw new Error(
        'Hermes orchestrator refused: could not establish the governed profile (deny native toolsets + o8-MCP-only). '
          + 'Hermes must be configured (hermes setup) and govern cleanly before it can orchestrate — running ungoverned '
          + 'would break the orchestrator≠worker guarantee (#1075).',
      );
    }
    return { command: bin, args: ['acp', '--accept-hooks'], env: { HOME: governed.home } };
  },
});

/** Generic ACP escape hatch — any ACP agent via O8_ACP_COMMAND / O8_ACP_ARGS. */
export const acpBackend: OrchestratorBackend = makeAcpBackend({
  id: 'acp',
  label: 'ACP',
  resolveLaunch: () => {
    const command = process.env.O8_ACP_COMMAND?.trim();
    if (!command) return null;
    const args = (process.env.O8_ACP_ARGS ?? '').split(' ').map((a) => a.trim()).filter(Boolean);
    return { command, args };
  },
});

/** Whether the Hermes ACP agent is available (binary present). */
export function isHermesAvailable(): boolean {
  const bin = resolveHermesBinary();
  if (!bin) return false;
  // Presence isn't health: ~/.local/bin/hermes is a wrapper script that execs
  // a Python venv — the 2026-07-07 storage cleanup deleted ~/.hermes and the
  // wrapper survived, so existsSync said "available" on a machine where every
  // Hermes turn could only fail (live-hit 2026-07-16, runtime sweep). Verify
  // the binary actually EXECUTES (cached — this gates a settings picker, not
  // a hot path).
  if (hermesHealthCache !== null) return hermesHealthCache;
  try {
    const probe = spawnSync(bin, ['--version'], { timeout: 5_000, stdio: 'ignore' });
    hermesHealthCache = probe.status === 0;
  } catch {
    hermesHealthCache = false;
  }
  return hermesHealthCache;
}

let hermesHealthCache: boolean | null = null;
