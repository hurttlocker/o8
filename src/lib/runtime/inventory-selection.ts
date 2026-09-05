import path from 'node:path';
import type { AgentSummary } from '@/lib/fleet/types';
import { isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { listCurrentIdeRepoPaths } from '@/lib/runtime/ide-terminal-state';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';

export function isRegistryBackedRuntimeSession(sessionKey: string) {
  return Boolean(getRuntimeTerminalSession(sessionKey));
}

function normalizeInventoryWorkspacePath(workspace?: string | null) {
  const trimmed = workspace?.trim();
  if (!trimmed) return null;
  const home = process.env.HOME ?? '';
  const expanded = trimmed.startsWith('~/') && home
    ? path.join(home, trimmed.slice(2))
    : trimmed === '~' && home
      ? home
      : trimmed;
  return path.normalize(expanded).toLowerCase();
}

export function selectRepoFallbackAgents(agents: AgentSummary[], existingSessionKeys: Set<string>) {
  const currentRepoPaths = new Set(listCurrentIdeRepoPaths());
  if (currentRepoPaths.size === 0) return [] as AgentSummary[];

  const selected: AgentSummary[] = [];
  const seenRepoRuntime = new Set<string>();

  for (const agent of agents) {
    if (existingSessionKeys.has(agent.sessionKey)) continue;
    if (!isDispatchableRuntime(agent.runtime)) continue;
    if (!['running', 'reviewing', 'waiting'].includes(agent.status)) continue;
    if (!agent.sessionKey.startsWith('codex-owned:') && !isRegistryBackedRuntimeSession(agent.sessionKey)) continue;

    const workspaceKey = normalizeInventoryWorkspacePath(agent.runtimeSurface?.cwd ?? agent.workspace);
    if (!workspaceKey || !currentRepoPaths.has(workspaceKey)) continue;

    const bucketKey = `${agent.runtime}:${workspaceKey}`;
    if (seenRepoRuntime.has(bucketKey)) continue;
    seenRepoRuntime.add(bucketKey);
    selected.push(agent);
  }

  return selected;
}
