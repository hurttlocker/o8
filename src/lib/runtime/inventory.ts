import type { FleetSnapshot, AgentSummary } from '@/lib/fleet/types';
import type { RuntimeSession } from '@/lib/runtimes/types';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';
import { claudeCodeRuntime } from '@/lib/runtimes/claude-code';

/* ── TTL cache for Claude Code discovery (avoids ps aux + dir scan every poll) ── */
const CC_DISCOVERY_TTL_MS = 30_000; // 30s cache
let ccDiscoveryCache: { sessions: RuntimeSession[]; cachedAt: number } | null = null;

async function getCachedCcSessions(): Promise<RuntimeSession[]> {
  const now = Date.now();
  if (ccDiscoveryCache && (now - ccDiscoveryCache.cachedAt) < CC_DISCOVERY_TTL_MS) {
    return ccDiscoveryCache.sessions;
  }
  const sessions = await claudeCodeRuntime.discoverSessions().catch(() => []);
  ccDiscoveryCache = { sessions, cachedAt: now };
  return sessions;
}

export async function getRuntimeInventorySnapshot(): Promise<FleetSnapshot> {
  const [ocSnapshot, ccSessions] = await Promise.all([
    getOpenClawFleetSnapshot(),
    getCachedCcSessions(),
  ]);

  // Deduplicate Claude Code sessions by sessionKey, prefer entries with tmuxSession
  const seen = new Map<string, typeof ccSessions[0]>();
  for (const s of ccSessions) {
    if (s.status !== 'running' && s.status !== 'reviewing') continue;
    const existing = seen.get(s.sessionKey);
    if (!existing || (s.tmuxSession && !existing.tmuxSession)) {
      seen.set(s.sessionKey, s);
    }
  }

  // Convert Claude Code RuntimeSessions into AgentSummary entries
  const ccAgents: (AgentSummary & { tmuxSession?: string })[] = [...seen.values()]
    .slice(0, 5) // limit to avoid bloating
    .map(s => ({
      id: s.sessionKey,
      name: s.displayName || 'Claude Code',
      squadId: 'claude-code',
      model: s.model ?? 'claude',
      status: s.status as AgentSummary['status'],
      currentTask: s.initialTask ?? '',
      workspace: s.cwd,
      sessionKey: s.sessionKey,
      runtime: 'claude-code',
      lastEventAt: s.lastActivityAt.toISOString(),
      surfaceLabel: `Claude Code • ${s.branch ?? 'unknown'}`,
      branch: s.branch ?? '',
      approvalStatus: 'none' as const,
      context: { usedPercent: s.contextUsedPercent ?? 0, trend: 'stable' as const },
      alerts: 0,
      tmuxSession: s.tmuxSession,
    }));

  // Build tmux lookup from discovered CC sessions
  const tmuxBySessionKey = new Map<string, string>();
  for (const agent of ccAgents) {
    if (agent.tmuxSession) {
      tmuxBySessionKey.set(agent.sessionKey, agent.tmuxSession);
    }
  }

  // Enrich existing OC agents with tmuxSession if they have a matching session key
  const enrichedOcAgents = ocSnapshot.agents.map(a => {
    const tmux = tmuxBySessionKey.get(a.sessionKey);
    if (tmux) return { ...a, tmuxSession: tmux };
    return a;
  });

  // Only add CC agents that aren't already in the OC snapshot
  const existingKeys = new Set(enrichedOcAgents.map(a => a.sessionKey));
  const newCcAgents = ccAgents.filter(a => !existingKeys.has(a.sessionKey));

  return {
    ...ocSnapshot,
    agents: [...enrichedOcAgents, ...newCcAgents],
  };
}
