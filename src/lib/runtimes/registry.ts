/**
 * Runtime Registry
 *
 * Central registration point for all agent runtimes.
 * The UI and API layer talk to the registry, never to a specific runtime.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentRuntime, RuntimeId, RuntimeSession } from './types';

const execAsync = promisify(exec);

const runtimes = new Map<RuntimeId, AgentRuntime>();

/**
 * Register an agent runtime. Called once at startup per runtime.
 */
export function registerRuntime(runtime: AgentRuntime): void {
  if (runtimes.has(runtime.id)) {
    console.warn(`[runtime-registry] Overwriting existing runtime: ${runtime.id}`);
  }
  runtimes.set(runtime.id, runtime);
}

/**
 * Get a specific runtime by ID.
 */
export function getRuntime(id: RuntimeId): AgentRuntime | undefined {
  return runtimes.get(id);
}

/**
 * Get all registered runtimes.
 */
export function getAllRuntimes(): AgentRuntime[] {
  return [...runtimes.values()];
}

/**
 * Get all runtime IDs that are registered.
 */
export function getRegisteredRuntimeIds(): RuntimeId[] {
  return [...runtimes.keys()];
}

/**
 * Discover sessions across ALL registered runtimes in parallel.
 * Failures in one runtime don't block others.
 */
export async function discoverAllSessions(): Promise<RuntimeSession[]> {
  const discoverableRuntimes = getAllRuntimes().filter((r) => r.capabilities.discover);
  if (discoverableRuntimes.length === 0) return [];

  const results = await Promise.allSettled(
    discoverableRuntimes.map(async (runtime) => {
      try {
        return await runtime.discoverSessions();
      } catch (err) {
        console.error(`[runtime-registry] Discovery failed for ${runtime.id}:`, err);
        return [] as RuntimeSession[];
      }
    }),
  );

  const sessions = results
    .filter((r): r is PromiseFulfilledResult<RuntimeSession[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Auto-clean: hide completed/idle sessions whose branch was merged/deleted (#503)
  // Use async exec to avoid blocking the event loop with git subprocess calls
  const keepFlags = await Promise.all(
    sessions.map(async (session) => {
      if (session.status !== 'completed' && session.status !== 'idle') return true;
      if (!session.branch || session.branch === 'main' || session.branch === 'master') return true;
      if (session.ownership === 'owned') return true;
      if (!session.cwd) return true;
      try {
        const { stdout } = await execAsync('git branch --list', { windowsHide: true, cwd: session.cwd, timeout: 2000 });
        // `git branch --list` prefixes the current branch with `* ` and a
        // branch checked out in a linked worktree with `+ ` — strip both, or
        // live worktree sessions get wrongly auto-cleaned.
        const branchExists = stdout.split('\n').some((line) => line.trim().replace(/^[*+] /, '') === session.branch);
        if (!branchExists) {
          console.log(`[runtime-registry] Auto-cleaning session ${session.sessionKey} — branch "${session.branch}" no longer exists`);
          return false;
        }
      } catch {
        // git failed — keep the session rather than hiding it
      }
      return true;
    }),
  );
  return sessions.filter((_, i) => keepFlags[i]);
}

/**
 * Perform an action on a session, routing to the correct runtime.
 */
export async function routeAction(
  runtimeId: RuntimeId,
  action: 'resume' | 'interrupt',
  sessionKey: string,
  message?: string,
) {
  const runtime = getRuntime(runtimeId);
  if (!runtime) {
    throw new Error(`Unknown runtime: ${runtimeId}`);
  }

  switch (action) {
    case 'resume': {
      if (!runtime.capabilities.resume) {
        throw new Error(`Runtime ${runtimeId} does not support resume`);
      }
      if (!message) throw new Error('Message is required for resume');
      return runtime.resume(sessionKey, message);
    }
    case 'interrupt': {
      if (!runtime.capabilities.interrupt) {
        throw new Error(`Runtime ${runtimeId} does not support interrupt`);
      }
      return runtime.interrupt(sessionKey);
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
