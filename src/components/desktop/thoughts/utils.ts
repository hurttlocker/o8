import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import { nextPacketReferenceLabel } from '@/lib/orchestrator/store';
import type {
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { AgentTarget, ContextSuggestion, FleetAgent } from './types';

export function normalizeMissionText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeMissionPrompt(value: string) {
  const normalized = normalizeMissionText(value);
  if (!normalized) return '';
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177).trimEnd()}...`;
}

export function createPacketId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pkt-${crypto.randomUUID()}`;
  }
  return `pkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDraftPacket(
  runtime: OrchestratorRuntime,
  workspaceTargets: OrchestratorWorkspaceTarget[],
  existingPackets: Array<Pick<OrchestratorPacket, 'referenceLabel'>>,
  seed?: Partial<OrchestratorPacket>,
): OrchestratorPacket {
  const target = seed?.workspaceTargetPath
    ? workspaceTargets.find((entry) => entry.localPath === seed.workspaceTargetPath) ?? null
    : workspaceTargets[0] ?? null;
  return {
    id: seed?.id ?? createPacketId(),
    referenceLabel: seed?.referenceLabel ?? nextPacketReferenceLabel(existingPackets),
    title: seed?.title ?? 'New work packet',
    summary: seed?.summary ?? '',
    workspaceTargetPath: seed?.workspaceTargetPath ?? target?.localPath ?? null,
    branchTarget: seed?.branchTarget ?? target?.branch ?? 'main',
    runtime: seed?.runtime ?? runtime,
    dependencyLabels: seed?.dependencyLabels ?? [],
    dependencyPacketIds: seed?.dependencyPacketIds ?? [],
    queueState: seed?.queueState ?? 'draft',
    releaseState: seed?.releaseState ?? 'pending',
    status: seed?.status ?? 'draft',
    blockedReason: seed?.blockedReason ?? null,
    lastEventAt: seed?.lastEventAt ?? null,
    lastEventLabel: seed?.lastEventLabel ?? null,
    lane: seed?.lane ?? null,
  };
}

export function packetTitleFromPrompt(value: string) {
  const normalized = normalizeMissionText(value);
  if (!normalized) return 'New work packet';
  const compact = normalized.replace(/[.?!]+$/g, '');
  if (compact.length <= 54) return compact;
  return `${compact.slice(0, 51).trimEnd()}...`;
}

export function pickWorkspaceTargetForText(
  text: string,
  workspaceTargets: OrchestratorWorkspaceTarget[],
) {
  const normalized = text.toLowerCase();
  return workspaceTargets.find((target) => {
    const repoName = target.repoName.toLowerCase();
    const label = target.label.toLowerCase();
    return normalized.includes(repoName) || normalized.includes(label);
  }) ?? workspaceTargets[0] ?? null;
}

export function buildPacketsFromMissionPrompt(
  prompt: string,
  workspaceTargets: OrchestratorWorkspaceTarget[],
  runtime: OrchestratorRuntime,
) {
  const clauses = prompt
    .split(/\n|;|(?:\s+and then\s+)|(?:\s+then\s+)/i)
    .map((part) => normalizeMissionText(part))
    .filter(Boolean)
    .slice(0, 5);
  const seeds = clauses.length > 0 ? clauses : [normalizeMissionText(prompt)].filter(Boolean);
  return seeds.map((seed, index) => {
    const target = pickWorkspaceTargetForText(seed, workspaceTargets);
    return createDraftPacket(runtime, workspaceTargets, Array.from({ length: index }).map((_, itemIndex) => ({
      referenceLabel: `P${itemIndex + 1}`,
    })), {
      title: packetTitleFromPrompt(seed),
      summary: seed,
      workspaceTargetPath: target?.localPath ?? null,
      branchTarget: target?.branch ?? (index === 0 ? 'main' : `packet-${index + 1}`),
      dependencyLabels: index === 0 ? [] : [`P${index}`],
      dependencyPacketIds: [],
      queueState: 'draft',
      releaseState: 'pending',
    });
  });
}

export function isRunnableCliSession(agent: FleetAgent) {
  const runtime = agent.runtime;
  const sessionKey = agent.sessionKey?.trim();
  if (!sessionKey) return false;
  if (runtime !== 'codex' && runtime !== 'claude-code') return false;
  if (sessionKey.includes(':ide-tab-')) return false;
  return true;
}

export function buildAgentTargets(
  agents: FleetAgent[],
  preferredRuntime: OrchestratorRuntime,
) {
  const cliAgents = agents
    .filter(isRunnableCliSession)
    .sort((left, right) => {
      const runtimeScore = (runtime?: string) => (runtime === preferredRuntime ? 2 : 1);
      const currentScore = (agent: FleetAgent) => (agent.isCurrentSession ? 2 : 0);
      const statusScore = (status?: string) => (status === 'running' ? 2 : status === 'reviewing' ? 1 : 0);
      const delta = runtimeScore(right.runtime) + currentScore(right) + statusScore(right.status)
        - runtimeScore(left.runtime) - currentScore(left) - statusScore(left.status);
      if (delta !== 0) return delta;
      return (right.lastEventAt ?? '').localeCompare(left.lastEventAt ?? '');
    });

  return cliAgents.map((agent) => {
    const runtime = agent.runtime === 'claude-code' ? 'claude-code' : 'codex';
    const runtimeTone = orchestratorRuntimeTone(runtime);
    return {
      key: agent.sessionKey!,
      name: agent.name?.trim() || runtimeTone.label,
      runtime,
      color: runtimeTone.color,
      workspace: agent.workspace?.trim() || null,
      isCurrentSession: Boolean(agent.isCurrentSession),
    } satisfies AgentTarget;
  });
}

export function entrySignature(entry: MobileTranscriptEntry) {
  return JSON.stringify({
    role: entry.role,
    text: entry.text,
    media: (entry.media ?? []).map((item) => `${item.kind}:${item.path}`),
    toolCalls: (entry.toolCalls ?? []).map((tool) => ({
      name: tool.name,
      args: tool.args,
      status: tool.status,
    })),
    timestamp: entry.timestamp,
    timestampLabel: entry.timestampLabel,
  });
}

export function isRenderableThoughtEntry(entry: MobileTranscriptEntry) {
  return Boolean(
    entry.text.trim()
    || entry.media?.length
    || entry.toolCalls?.length,
  );
}

export function mergeTranscriptEntries(
  existing: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
) {
  if (incoming.length === 0) return existing;

  const next = [...existing];
  const indexById = new Map(next.map((entry, index) => [entry.id, index]));

  for (const entry of incoming) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex == null) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      continue;
    }
    next[existingIndex] = entry;
  }

  return next;
}

export function generateSuggestions(agents: FleetAgent[], targets: AgentTarget[]): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];
  const targetBySessionKey = new Map(targets.map((target) => [target.key, target]));
  const targetByName = new Map(targets.map((target) => [target.name.toLowerCase(), target]));
  const targetByRuntime = new Map<OrchestratorRuntime, AgentTarget>();
  targets.forEach((target) => {
    if (!targetByRuntime.has(target.runtime)) {
      targetByRuntime.set(target.runtime, target);
    }
  });

  for (const agent of agents) {
    const name = agent.name || 'Unknown';
    const runtime = agent.runtime === 'claude-code' ? 'claude-code' : 'codex';
    const target = (agent.sessionKey ? targetBySessionKey.get(agent.sessionKey) : null)
      ?? targetByName.get(name.toLowerCase())
      ?? targetByRuntime.get(runtime)
      ?? targets[0];
    if (!target) continue;

    const ctx = agent.context?.usedPercent ?? 0;
    if (ctx > 80) {
      suggestions.push({
        text: `${name} is at ${Math.round(ctx)}% context — approaching limit`,
        action: `What's your context status? Do you need to compact?`,
        agent: target,
        priority: ctx > 90 ? 'critical' : 'warn',
      });
    }

    if (agent.status === 'failed' || agent.status === 'error') {
      suggestions.push({
        text: `${name} has failed — may need intervention`,
        action: `What happened? Can you recover?`,
        agent: target,
        priority: 'critical',
      });
    }

    if (agent.status === 'idle' && agent.currentTask) {
      const lastEvent = agent.lastEventAt ? new Date(agent.lastEventAt).getTime() : 0;
      const idleMinutes = lastEvent ? (Date.now() - lastEvent) / 60000 : 0;
      if (idleMinutes > 30) {
        suggestions.push({
          text: `${name} has been idle ${Math.round(idleMinutes)}min with task: "${agent.currentTask}"`,
          action: `Status update on "${agent.currentTask}"?`,
          agent: target,
          priority: 'warn',
        });
      }
    }

    if (agent.alerts && agent.alerts > 0) {
      suggestions.push({
        text: `${name} has ${agent.alerts} alert${agent.alerts > 1 ? 's' : ''}`,
        action: `What alerts do you have? Anything I should know?`,
        agent: target,
        priority: 'warn',
      });
    }
  }

  const priorityOrder = { critical: 0, warn: 1, info: 2 };
  suggestions.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]);

  return suggestions.slice(0, 3);
}
