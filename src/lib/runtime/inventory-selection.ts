import path from 'node:path';
import type { AgentSummary } from '@/lib/fleet/types';
import { isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { listCurrentIdeRepoPaths } from '@/lib/runtime/ide-terminal-state';
import { DASHBOARD_CLI_BINDING_TTL_MS, getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';

export function isRegistryBackedRuntimeSession(sessionKey: string) {
  const entry = getRuntimeTerminalSession(sessionKey);
  if (!entry) return false;
  if (entry.source !== 'dashboard-cli-detected') return true;
  if (sessionKey.startsWith('codex-live:')) return false;
  const observedAt = Date.parse(entry.updatedAt);
  return Number.isFinite(observedAt) && Date.now() - observedAt < DASHBOARD_CLI_BINDING_TTL_MS;
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
