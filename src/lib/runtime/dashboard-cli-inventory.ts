import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';
import { discoverDashboardCliBindings } from '@/lib/runtime/dashboard-cli-bindings';
import { isRegistryBackedRuntimeSession } from '@/lib/runtime/inventory-selection';
import { getRuntimeTerminalSession, registerRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { runtimeSessionStatusFromTerminalState, unknownTerminalStatusEvidence, type TerminalStatusEvidence } from '@/lib/terminal-status/resolve';

type DiscoveredSession = { runtime: AgentRuntime; session: RuntimeSession };
type CliProjection = { session: RuntimeSession; statusEvidence: TerminalStatusEvidence };

export async function registerDashboardCliBindings(
  discovered: DiscoveredSession[],
): Promise<Map<string, string>> {
  const bindings = await discoverDashboardCliBindings(discovered.map(({ session }) => session));
  for (const { runtime, session } of discovered) {
    const terminal = bindings.get(session.sessionKey);
    if (!terminal || (runtime.id !== 'codex' && runtime.id !== 'claude-code')) continue;
    session.tmuxSession = terminal;
    registerRuntimeTerminalSession(session.sessionKey, {
      sessionName: terminal,
      runtime: runtime.id === 'codex' ? 'codex' : 'claude-code',
      cwd: session.cwd,
      source: 'dashboard-cli-detected',
    });
  }
  return bindings;
}

export function projectDashboardCliSession(
  runtime: AgentRuntime,
  session: RuntimeSession,
  bindings: Map<string, string>,
  turnEvidence: Map<string, TerminalStatusEvidence> = new Map(),
): CliProjection | null {
  if (bindings.has(session.sessionKey) && session.ownership === 'discovered') {
    const structured = turnEvidence.get(session.sessionKey);
    return {
      session: structured?.authority === 'runtime-event'
        ? {
            ...session,
            status: runtimeSessionStatusFromTerminalState(structured.state, session.status),
            lastActivityAt: new Date(structured.observedAt),
          }
        : session,
      statusEvidence: structured ?? unknownTerminalStatusEvidence({
        sessionId: session.sessionKey,
        runtime: runtime.id,
        observedAt: new Date(),
        summary: 'The CLI process is live in this o8 terminal; its current task state is unknown.',
        fallbackReason: 'Process and TTY identity confirm the terminal binding, but no runtime event confirms whether a turn is working, waiting, or complete.',
      }),
    };
  }
  const priorBinding = getRuntimeTerminalSession(session.sessionKey);
  const cliExited = priorBinding?.source === 'dashboard-cli-detected'
    && !bindings.has(session.sessionKey)
    && isRegistryBackedRuntimeSession(session.sessionKey);
  if (!cliExited) return null;
  return {
    session: {
      ...session,
      status: 'idle',
      tmuxSession: undefined,
      initialTask: 'CLI process no longer verified. The runtime history remains available.',
      lastActivityAt: new Date(priorBinding.updatedAt),
    },
    statusEvidence: unknownTerminalStatusEvidence({
      sessionId: session.sessionKey,
      runtime: runtime.id,
      observedAt: priorBinding.updatedAt,
      summary: 'The CLI was last verified in this o8 terminal at the observation time.',
      fallbackReason: 'The CLI process is no longer verified on the terminal TTY; no completion or read outcome is inferred.',
    }),
  };
}
