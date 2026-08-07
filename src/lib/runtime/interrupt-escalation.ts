import { isBridgeSessionAlive, signalBridgeTerminalSession } from '@/lib/runtime/pty-bridge';
import { lookupOwnedActiveRun } from '@/lib/runtimes/shared/owned-session-index';
import { isPidAlive, pidCommandLine } from '@/lib/runtimes/shared/owned-session/helpers';

export type InterruptEscalationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/**
 * What the ladder ACTUALLY did, as opposed to which rung asked for it.
 *
 * On POSIX the two are the same — the rung's signal is delivered. Windows has
 * exactly one mechanism (`taskkill /PID <pid> /T /F`), so all three rungs do the
 * same forced tree-kill, and recording them as SIGINT/SIGTERM/SIGKILL tells the
 * operator a worker was asked politely when it was actually shot. The audit
 * trail for a stop button has to say which it was.
 */
export type InterruptEscalationMechanism = InterruptEscalationSignal | 'taskkill-tree';

export interface InterruptEscalationTarget {
  pid?: number;
  tmuxSession?: string;
  commandLabel?: string;
}

export interface InterruptEscalationStep {
  /** The rung of the ladder — what was requested. */
  signal: InterruptEscalationSignal;
  /** What was actually used. Differs from `signal` on Windows. */
  mechanism: InterruptEscalationMechanism;
  sent: boolean;
  aliveAfter: boolean;
  error?: string;
}

export interface InterruptEscalationResult {
  attempted: boolean;
  confirmedDead: boolean;
  alreadyDead: boolean;
  steps: InterruptEscalationStep[];
  pid?: number;
  tmuxSession?: string;
  note: string;
}

export interface InterruptEscalationDeps {
  isAlive(target: InterruptEscalationTarget): Promise<boolean> | boolean;
  kill(target: InterruptEscalationTarget, signal: InterruptEscalationSignal): Promise<void> | void;
  sleep(ms: number): Promise<void>;
}

const ESCALATION_STEPS: ReadonlyArray<{ signal: InterruptEscalationSignal; waitMs: number }> = [
  { signal: 'SIGINT', waitMs: 1_000 },
  { signal: 'SIGTERM', waitMs: 1_500 },
  { signal: 'SIGKILL', waitMs: 2_000 },
];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The mechanism `defaultKill` will use for this target on this platform.
 *
 * Derived rather than reported back by the kill so it is recorded correctly on
 * the FAILURE path too — a taskkill that was denied is still a taskkill, and
 * labelling that attempt 'SIGINT' is exactly the claim this exists to stop.
 */
export function interruptMechanism(
  target: InterruptEscalationTarget,
  signal: InterruptEscalationSignal,
): InterruptEscalationMechanism {
  // The tmux bridge delivers the real signal, whatever the host platform.
  if (target.tmuxSession) return signal;
  if (process.platform !== 'win32') return signal;
  return 'taskkill-tree';
}

async function defaultIsAlive(target: InterruptEscalationTarget): Promise<boolean> {
  if (target.tmuxSession && await isBridgeSessionAlive(target.tmuxSession)) return true;
  return isPidAlive(target.pid);
}

async function defaultKill(target: InterruptEscalationTarget, signal: InterruptEscalationSignal): Promise<void> {
  if (target.tmuxSession) {
    await signalBridgeTerminalSession(target.tmuxSession, signal);
    return;
  }
  if (!target.pid) return;
  if (process.platform === 'win32') {
    // Windows has no negative-pid process groups, and the recorded pid is the
    // INTERPRETER — the runtime CLI is its child. TerminateProcess on the
    // interpreter alone leaves the agent running while isPidAlive(pid) goes
    // false, which reported `confirmedDead: true` for a worker that was still
    // editing files. A silent no-op is bad; a false confirmation of death on
    // the operator's stop button is worse.
    const { forceKillTreeWindows } = await import('@/lib/runtimes/shared/owned-session/helpers');
    // Windows has one mechanism here, so every rung of the ladder is the same
    // hard tree-kill. Say so rather than letting the audit trail record a
    // graceful SIGINT that was really a /F, and surface a failed kill instead
    // of leaving the caller to infer success from a liveness check.
    // taskkill exits non-zero both when it is DENIED and when the pid is
    // already gone. Those are opposite outcomes and the recorded pid cannot
    // distinguish them: it is the interpreter, and the CLI grandchild can
    // outlive it. Report the failure either way rather than inferring success
    // from the interpreter's absence — inferring is precisely how this path
    // reported confirmedDead for a worker that was still editing files.
    if (!await forceKillTreeWindows(target.pid)) {
      throw new Error(
        `taskkill could not confirm the process tree for pid ${target.pid} was stopped (requested ${signal})`,
      );
    }
    return;
  }
  try {
    process.kill(-target.pid, signal);
  } catch {
    process.kill(target.pid, signal);
  }
}

export async function escalateInterrupt(
  target: InterruptEscalationTarget,
  deps: Partial<InterruptEscalationDeps> = {},
): Promise<InterruptEscalationResult> {
  const runtimeDeps: InterruptEscalationDeps = {
    isAlive: deps.isAlive ?? defaultIsAlive,
    kill: deps.kill ?? defaultKill,
    sleep: deps.sleep ?? defaultSleep,
  };
  const steps: InterruptEscalationStep[] = [];

  if (!await runtimeDeps.isAlive(target)) {
    return {
      attempted: false,
      confirmedDead: true,
      alreadyDead: true,
      steps,
      pid: target.pid,
      tmuxSession: target.tmuxSession,
      note: 'No live process was attached to this session.',
    };
  }

  for (const step of ESCALATION_STEPS) {
    const mechanism = interruptMechanism(target, step.signal);
    let sent = false;
    let error: string | undefined;
    try {
      await runtimeDeps.kill(target, step.signal);
      sent = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    await runtimeDeps.sleep(step.waitMs);
    const aliveAfter = await runtimeDeps.isAlive(target);
    steps.push({ signal: step.signal, mechanism, sent, aliveAfter, error });
    if (!aliveAfter) {
      return {
        attempted: true,
        confirmedDead: true,
        alreadyDead: false,
        steps,
        pid: target.pid,
        tmuxSession: target.tmuxSession,
        note: `Worker stopped after ${mechanism}.`,
      };
    }
  }

  return {
    attempted: true,
    confirmedDead: false,
    alreadyDead: false,
    steps,
    pid: target.pid,
    tmuxSession: target.tmuxSession,
    note: `Worker remained live after ${describeAttempts(steps)}.`,
  };
}

/**
 * Name what was tried, without repeating one mechanism three times. Windows
 * runs the same tree-kill on every rung, so "SIGINT, SIGTERM, and SIGKILL"
 * would describe an escalation that never happened.
 */
function describeAttempts(steps: InterruptEscalationStep[]): string {
  const mechanisms = [...new Set(steps.map((step) => step.mechanism))];
  if (mechanisms.length === 1 && steps.length > 1) {
    return `${steps.length} ${mechanisms[0]} attempts`;
  }
  if (mechanisms.length > 1) {
    return `${mechanisms.slice(0, -1).join(', ')}, and ${mechanisms[mechanisms.length - 1]}`;
  }
  return mechanisms[0] ?? 'no attempts';
}

function ownedRuntimeCommandLabel(surfaceId: string): string | null {
  if (surfaceId.startsWith('codex-owned:')) return 'codex';
  if (surfaceId.startsWith('claude-code-owned:')) return 'claude';
  return null;
}

export async function escalateInterruptOwnedSurface(surfaceId: string): Promise<InterruptEscalationResult | null> {
  const commandLabel = ownedRuntimeCommandLabel(surfaceId);
  if (!commandLabel) return null;

  const activeRun = await lookupOwnedActiveRun(surfaceId);
  if (!activeRun) {
    return {
      attempted: false,
      confirmedDead: true,
      alreadyDead: true,
      steps: [],
      note: 'Owned runtime surface exists outside the live inventory or has no active run.',
    };
  }

  if (activeRun.pid) {
    const commandLine = await pidCommandLine(activeRun.pid);
    if (!commandLine || !commandLine.includes(commandLabel)) {
      return {
        attempted: false,
        confirmedDead: true,
        alreadyDead: true,
        steps: [],
        pid: activeRun.pid,
        tmuxSession: activeRun.tmuxSession,
        note: `Stored pid ${activeRun.pid} no longer matches an owned ${commandLabel} run.`,
      };
    }
  }

  return escalateInterrupt({
    pid: activeRun.pid,
    tmuxSession: activeRun.tmuxSession,
    commandLabel,
  });
}
