import { normalizeRepoPath } from '../use-orchestrator-stream/shared';

interface IdleSession {
  sessionKey: string;
  runtime: string;
  status: string;
  workspace: string;
}

export function findIdleOrchestratorSession(agents: IdleSession[], repoPath: string): IdleSession | null {
  const target = normalizeRepoPath(repoPath);
  if (!target) return null;
  return agents.find((agent) => agent.runtime === 'claude-code'
    && (agent.status === 'idle' || agent.status === 'reviewing')
    && normalizeRepoPath(agent.workspace) === target) ?? null;
}
