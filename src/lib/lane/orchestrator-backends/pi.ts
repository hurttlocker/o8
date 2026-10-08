/**
 * Pi orchestrator backend (#3258): the bundled Pi SDK session as the
 * orchestrator, on the managed model route (paid plan token or the free
 * allowance; the worker never holds a credential).
 *
 * Pi gets the same built-in o8 servers as the Claude orchestrator (operator and
 * cortex, projected by the turn's tool profile) through three catalog tools, so
 * every o8 command is reachable without sending every schema on every call. Its
 * own file writes and commands in the repo keep per-call approval in the inbox.
 * A plan-mode turn gets the proposer projection and only `read_file`.
 *
 * One turn at a time per repo and thread, and one resident Pi process for it.
 * The session file lives under the o8 data directory, so a new process after a
 * restart, failure or idle close resumes the same conversation.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { buildOrchestratorSystemPrompt } from '@/lib/lane/orchestrator-system-prompt';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { createO8CommandTools, listO8Commands, o8CommandPrompt } from '@/lib/pi/orchestrator/o8-commands';
import { openO8Servers, type O8ServerSet } from '@/lib/pi/orchestrator/o8-servers';
import { O8_MANAGED_PI_MODEL } from '@/lib/pi/sdk/live-contract';
import type { createPiSdkSession, PiSdkSessionOptions } from '@/lib/pi/sdk/session';
import { newestPiSessionFile } from '@/lib/pi/sdk/session-files';
import type { OrchestratorBackend, OrchestratorSessionInfo, OrchestratorTurnOptions } from './types';

/** Per-turn limits. A turn that dispatches and waits on a mission needs more than the prototype's defaults. */
export const PI_ORCHESTRATOR_LIMITS = { maxModelCalls: 40, maxToolCalls: 80, runTimeoutMs: 30 * 60_000 } as const;
/** An idle thread's Pi and cortex processes close after this; the next message resumes from the session file. */
export const PI_ORCHESTRATOR_IDLE_MS = 15 * 60_000;

type PiSession = Awaited<ReturnType<typeof createPiSdkSession>>;

/** The tool surface a resident was started with. A turn needing another one gets a new process. */
interface PiSurface {
  profile: ToolProfile;
  readOnly: boolean;
}

interface ResidentPi extends PiSurface {
  name: string;
  session: PiSession;
  servers: O8ServerSet;
  emit?: (event: OrchestratorEvent) => void;
  idle?: ReturnType<typeof setTimeout>;
}

/** Plan mode is read-only, like Claude's plan mode: proposer servers and no repo writes or commands. */
export function piSurfaceForTurn(options: OrchestratorTurnOptions): PiSurface {
  const plan = options.permissionMode === 'plan';
  const profile: ToolProfile = plan ? 'propose' : options.toolProfile ?? 'full';
  return { profile, readOnly: plan || profile === 'propose' };
}

/** Start failures o8 itself explains; anything else stays in the host log. */
const PI_START_FAILURE_TEXT = /^The Pi prototype (?:needs Node|does not support)/;

/** Trusted seams for tests. Production uses the managed transport, the inbox and /api/mcp. */
export interface PiOrchestratorDeps {
  transport?: PiSdkSessionOptions['transport'];
  approve?: PiSdkSessionOptions['approve'];
  openServers?: typeof openO8Servers;
  stateRoot?: () => string;
  idleMs?: number;
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text : '')).join('\n');
}

/**
 * Maps one Pi agent event to orchestrator stream events. Only text and tool
 * activity cross; message objects, which can carry provider diagnostics, never do.
 */
export function piEventToOrchestratorEvents(event: Record<string, unknown>): OrchestratorEvent[] {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
    if (typeof update?.delta !== 'string' || !update.delta) return [];
    if (update.type === 'text_delta') return [{ type: 'text', text: update.delta }];
    if (update.type === 'thinking_delta') return [{ type: 'thinking', text: update.delta }];
    return [];
  }
  if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
    return [{ type: 'tool_use', id: typeof event.toolCallId === 'string' ? event.toolCallId : null, name: event.toolName, input: event.args ?? {} }];
  }
  if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') {
    return [{
      type: 'tool_result',
      id: typeof event.toolCallId === 'string' ? event.toolCallId : null,
      name: event.toolName,
      output: textOf(event.result),
      isError: event.isError === true,
    }];
  }
  return [];
}

export function createPiOrchestratorBackend(deps: PiOrchestratorDeps = {}): OrchestratorBackend & {
  closeAll(): Promise<void>;
} {
  const resident = new Map<string, ResidentPi>();
  /** Threads with a turn in flight, startup included. Reserved before any await. */
  const active = new Set<string>();
  const inflight = new Set<Promise<void>>();
  const ensured = new Set<string>();
  let closing = false;
  const stateRoot = deps.stateRoot ?? (() => join(getDataDir(), 'pi', 'orchestrator'));

  const nameFor = (repoPath: string, threadId?: string | null) => sessionNameForRepo('pi-orchestrator', repoPath, threadId);

  /** Closes one resident; the map entry goes only if it still names this resident. */
  async function close(pi: ResidentPi) {
    clearTimeout(pi.idle);
    if (resident.get(pi.name) === pi) resident.delete(pi.name);
    await Promise.allSettled([pi.session.close(), pi.servers.close()]);
  }

  async function start(name: string, repoPath: string, options: OrchestratorTurnOptions, surface: PiSurface): Promise<ResidentPi> {
    const stateDir = join(stateRoot(), createHash('sha256').update(name).digest('hex').slice(0, 32));
    const signal = options.signal ?? new AbortController().signal;
    const servers = await (deps.openServers ?? openO8Servers)(repoPath, { profile: surface.profile, threadId: options.threadId });
    try {
      const commands = servers.servers.length ? await listO8Commands(servers.servers, signal) : [];
      const systemPrompt = [
        buildOrchestratorSystemPrompt(repoPath, { backend: 'pi', toolProfile: surface.profile }),
        commands.length ? o8CommandPrompt(commands) : '',
      ].filter(Boolean).join('\n\n');
      const pi = { name, servers, ...surface } as ResidentPi;
      // Loaded on the first Pi turn, so ws-server startup never evaluates the Pi SDK.
      const { createPiSdkSession } = await import('@/lib/pi/sdk/session');
      pi.session = await createPiSdkSession({
        workspace: repoPath,
        stateDir,
        model: O8_MANAGED_PI_MODEL,
        sessionFile: await newestPiSessionFile(join(stateDir, 'sessions')),
        transport: deps.transport,
        approve: deps.approve,
        hostTools: commands.length ? createO8CommandTools(commands) : [],
        systemPrompt,
        readOnly: surface.readOnly,
        onEvent: (event) => {
          for (const mapped of piEventToOrchestratorEvents(event)) pi.emit?.(mapped);
        },
        ...PI_ORCHESTRATOR_LIMITS,
      });
      return pi;
    } catch (error) {
      await servers.close();
      throw error;
    }
  }

  async function runTurn(name: string, repoPath: string, message: string, onEvent: (event: OrchestratorEvent) => void,
    options: OrchestratorTurnOptions) {
    let sessionId: string | null = null;
    const done = () => onEvent({ type: 'done', sessionId, cost: null });
    const surface = piSurfaceForTurn(options);
    let pi = resident.get(name);
    // A different tool surface needs a different process; the session file keeps the conversation.
    if (pi && (pi.profile !== surface.profile || pi.readOnly !== surface.readOnly || !pi.session.running)) {
      await close(pi);
      pi = undefined;
    }
    if (!pi) {
      try {
        pi = await start(name, repoPath, options, surface);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!PI_START_FAILURE_TEXT.test(detail)) console.warn('[pi-orchestrator] Pi could not start:', error);
        if (!options.signal?.aborted) {
          onEvent({ type: 'error', error: PI_START_FAILURE_TEXT.test(detail) ? detail : 'Pi could not start. Details are in the o8 log.' });
        }
        done();
        return;
      }
      if (closing) {
        await close(pi);
        done();
        return;
      }
      resident.set(name, pi);
    }
    const current = pi;
    sessionId = current.session.sessionId;
    clearTimeout(current.idle);
    current.emit = onEvent;
    onEvent({ type: 'turn_receipt', leadModel: 'pi', effort: options.thinkingEffort ?? 'medium' });
    const stop = () => { void current.session.abort(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    try {
      if (options.signal?.aborted) return;
      const result = await current.session.prompt(message);
      if (result.errorMessage && !options.signal?.aborted) onEvent({ type: 'error', error: result.errorMessage });
    } catch (error) {
      // A failed prompt closes the Pi process; the next message starts a new one on the same session file.
      await close(current);
      if (!options.signal?.aborted) {
        console.warn('[pi-orchestrator] Pi run failed:', error);
        onEvent({ type: 'error', error: 'Pi stopped unexpectedly. Send the message again to continue.' });
      }
    } finally {
      options.signal?.removeEventListener('abort', stop);
      current.emit = undefined;
      if (resident.get(name) === current) {
        current.idle = setTimeout(() => { if (!active.has(name)) void close(current); },
          deps.idleMs ?? PI_ORCHESTRATOR_IDLE_MS);
        current.idle.unref?.();
      }
      done();
    }
  }

  function sendTurn(repoPath: string, message: string, onEvent: (event: OrchestratorEvent) => void,
    options: OrchestratorTurnOptions = {}): Promise<void> {
    const name = nameFor(repoPath, options.threadId);
    ensured.add(name);
    if (closing || active.has(name)) {
      onEvent({ type: 'error', error: closing ? 'Pi is shutting down.' : 'Pi is still working on the previous message in this thread.' });
      onEvent({ type: 'done', sessionId: resident.get(name)?.session.sessionId ?? null, cost: null });
      return Promise.resolve();
    }
    active.add(name);
    const turn = runTurn(name, repoPath, message, onEvent, options).finally(() => {
      active.delete(name);
      inflight.delete(turn);
    });
    inflight.add(turn);
    return turn;
  }

  const status = (name: string) => (active.has(name) ? 'busy' as const : 'ready' as const);

  return {
    id: 'pi',
    label: 'Pi',
    peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
      const name = nameFor(repoPath, threadId);
      return ensured.has(name) ? { sessionName: name, status: status(name) } : null;
    },
    ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
      const name = nameFor(repoPath, threadId);
      ensured.add(name);
      return { sessionName: name, status: status(name) };
    },
    sendTurn,
    /** Ends every turn and process, including ones still starting. */
    async closeAll() {
      closing = true;
      await Promise.allSettled([...resident.values()].map(close));
      await Promise.allSettled([...inflight]);
      await Promise.allSettled([...resident.values()].map(close));
      closing = false;
    },
  };
}

export const piBackend = createPiOrchestratorBackend();
