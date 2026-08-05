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

import { AcpClient, mapStopReason, type AcpConfigOption, type AcpMcpServer } from '@/lib/acp/client';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import { resolveOpencodeOrchestratorModelSync } from '@/lib/operator/defaults';
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
  /** `session/new`'s configOptions — the agent's own model/mode catalogue. */
  configOptions: AcpConfigOption[];
  /** Last model pushed via `session/set_model`, so we only switch on change. */
  appliedModel: string | null;
  /** The current turn's event sink — set by sendTurn, cleared on completion. */
  onEvent?: (event: OrchestratorEvent) => void;
}

const sessions = new Map<string, AcpSession>();
let acpRealtimeSeq = 0;

/**
 * Last-seen `configOptions` per backend id, so the model picker can render
 * without holding a live session open. Populated on every handshake; empty
 * until the operator's first turn on that backend (the picker falls back to
 * "no models discovered yet" rather than a hardcoded list).
 */
const sessionConfigCache = new Map<OrchestratorBackendId, AcpConfigOption[]>();

/**
 * The operator's pinned default model for a backend, or null when unpinned.
 * Only opencode has a setting today; other ACP agents run on their own default.
 */
function defaultModelFor(id: OrchestratorBackendId): string | null {
  if (id !== 'opencode') return null;
  try {
    return resolveOpencodeOrchestratorModelSync();
  } catch {
    return null;
  }
}

/** The `model` select out of a configOptions array, if the agent exposes one. */
function modelConfigOption(options: AcpConfigOption[]): AcpConfigOption | null {
  return options.find((opt) => opt.id === 'model' || opt.category === 'model') ?? null;
}

/**
 * The models an ACP backend last reported it can run. Empty when that backend
 * has never completed a handshake in this process.
 */
export function acpBackendModels(id: OrchestratorBackendId): Array<{ value: string; name?: string }> {
  return modelConfigOption(sessionConfigCache.get(id) ?? [])?.options ?? [];
}

/** Whichever model the backend reported as current at its last handshake. */
export function acpBackendCurrentModel(id: OrchestratorBackendId): string | null {
  return modelConfigOption(sessionConfigCache.get(id) ?? [])?.currentValue ?? null;
}

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
      configOptions: [],
      appliedModel: null,
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
    const created = await session.client.newSession(session.repoPath, o8McpServersForAcp(session.repoPath));
    session.sessionId = created.sessionId;
    session.configOptions = created.configOptions;
    // The agent reports what it booted with, so a composer pick that already
    // matches costs no set_model round-trip on the first turn.
    session.appliedModel = modelConfigOption(session.configOptions)?.currentValue ?? null;
    if (session.configOptions.length) {
      sessionConfigCache.set(id, session.configOptions);
    }
    return session.sessionId;
  }

  /**
   * Push the composer's model onto the live session. Skipped when unchanged, and
   * never fatal: an agent without a model axis rejects `session/set_model` with
   * "Method not found", which must not take the turn down with it — the turn
   * simply runs on whatever the agent already had.
   */
  async function applyModel(session: AcpSession, sessionId: string, model?: string): Promise<void> {
    // Precedence: the composer's per-turn pick, then the operator's pinned
    // default, then whatever the agent booted with. The last one is a real
    // option, not a failure — an unpinned backend still runs.
    const requested = (model?.trim() || defaultModelFor(id)) ?? undefined;
    if (!requested || requested === session.appliedModel) return;
    try {
      await session.client.setModel(sessionId, requested);
      session.appliedModel = requested;
    } catch (err) {
      console.log(`[acp-orchestrator] ${label} refused model ${requested}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

      // Silent-empty-turn guard. opencode's `session/set_model` validates
      // NOTHING — a model the install isn't authenticated for, and even a
      // outright bogus id, both return success and then produce a turn that
      // ends `end_turn` with zero assistant output (verified 2026-08-04 against
      // opencode 1.4.3 with `opencode/minimax-m2.5-free` and
      // `openrouter/does/not-exist`). Reporting that as a clean `done` shows the
      // operator an empty reply and no reason, which is the worst outcome. Count
      // real output so a turn that produced none can say why.
      let produced = 0;
      const countingOnEvent = (event: OrchestratorEvent) => {
        if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_use') produced += 1;
        onEvent(event);
      };
      session.onEvent = countingOnEvent;

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
        await applyModel(session, sessionId, options?.model);
        const stopReason = await session.client.prompt(sessionId, message);
        const doneOrError = produced === 0 && stopReason === 'end_turn'
          ? ({
            type: 'error',
            error: session.appliedModel
              ? `${label} finished the turn without producing any output on model "${session.appliedModel}". `
                + 'That model is usually not authenticated for this install, or the id does not exist — '
                + 'this agent accepts unknown model ids silently. Pick a different model.'
              : `${label} finished the turn without producing any output.`,
          } satisfies OrchestratorEvent)
          : mapStopReason(stopReason, sessionId);
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

/** Resolve the `opencode` binary (PATH-ish); null when not installed. */
function resolveOpencodeBinary(): string | null {
  for (const candidate of [
    process.env.O8_OPENCODE_BIN,
    `${process.env.HOME ?? ''}/.npm-global/bin/opencode`,
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    `${process.env.HOME ?? ''}/.local/bin/opencode`,
    `${process.env.HOME ?? ''}/.opencode/bin/opencode`,
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * opencode via `opencode acp` — the model-agnostic orchestrator.
 *
 * Unlike every other backend, this one is not bound to a provider house: the
 * session's own `configOptions.model` select is the catalogue, scoped to
 * whatever providers the local install is authenticated for. Verified against
 * opencode 1.4.3 on 2026-08-04:
 *   - NDJSON JSON-RPC on stdio, protocolVersion 1 — the shape AcpClient sends;
 *   - o8's operator MCP server loads over stdio (`toolCount=92`), so this
 *     backend can genuinely dispatch rather than only converse;
 *   - `session/new` returns 864 model options including `/low` + `/high`
 *     reasoning variants, so thinking level rides the model id;
 *   - `session/set_model {sessionId, modelId}` switches models on the live
 *     session, no respawn.
 *
 * `mcpCapabilities` advertises only `{http, sse}`, which reads like stdio is
 * unsupported. It is not — stdio is the ACP baseline and those flags mark the
 * extra transports. Don't "fix" the injection path on the strength of that.
 */
export const opencodeBackend: OrchestratorBackend = makeAcpBackend({
  id: 'opencode',
  label: 'opencode',
  resolveLaunch: () => {
    const bin = resolveOpencodeBinary();
    if (!bin) return null;
    return { command: bin, args: ['acp'] };
  },
});

/**
 * The launch spec for an ACP backend, for callers that need to drive the agent
 * outside a turn (the model-catalogue probe). Null when unavailable.
 */
export function resolveAcpLaunch(id: OrchestratorBackendId): AcpLaunch | null {
  if (id === 'opencode') {
    const bin = resolveOpencodeBinary();
    return bin ? { command: bin, args: ['acp'] } : null;
  }
  return null;
}

/** Whether the opencode ACP agent is available (binary present AND executes). */
export function isOpencodeAcpAvailable(): boolean {
  const bin = resolveOpencodeBinary();
  if (!bin) return false;
  if (opencodeHealthCache !== null) return opencodeHealthCache;
  try {
    const probe = spawnSync(bin, ['--version'], { timeout: 5_000, stdio: 'ignore' });
    opencodeHealthCache = probe.status === 0;
  } catch {
    opencodeHealthCache = false;
  }
  return opencodeHealthCache;
}

let opencodeHealthCache: boolean | null = null;

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
