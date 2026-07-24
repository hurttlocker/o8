import { agentDisplayLabel } from '@/lib/orchestrator/display';
import type { AgentSummary } from '@/lib/fleet/types';

export type AddressableFleetAgent =
  & Pick<AgentSummary, 'id'>
  & Partial<Pick<
    AgentSummary,
    'name' | 'runtime' | 'sessionKey' | 'currentTask' | 'workspace' | 'branch'
  >>
  & {
    laneId?: string | null;
    packetId?: string | null;
    packetTitle?: string | null;
    packetReferenceLabel?: string | null;
    aliases?: readonly string[];
  };

export interface AgentAddressCandidate {
  agentId: string;
  laneId: string | null;
  packetId: string | null;
  label: string;
  score: number;
  matchedFields: string[];
}

export interface AgentAddressResolution {
  match: AgentAddressCandidate | null;
  candidates: AgentAddressCandidate[];
  disambiguationPrompt: string | null;
}

const ADDRESS_STOP_WORDS = new Set([
  'agent',
  'one',
  'packet',
  'please',
  'the',
  'this',
  'worker',
]);

function normalizeReference(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function referenceTokens(value: string): string[] {
  return normalizeReference(value)
    .split(' ')
    .filter((token) => token && !ADDRESS_STOP_WORDS.has(token));
}

function candidateFields(agent: AddressableFleetAgent) {
  const label = agentDisplayLabel({
    name: agent.name,
    sessionKey: agent.sessionKey,
    runtime: agent.runtime,
  });
  return {
    label,
    fields: [
      { name: 'label', value: label, weight: 12 },
      { name: 'packetTitle', value: agent.packetTitle, weight: 10 },
      { name: 'packetReferenceLabel', value: agent.packetReferenceLabel, weight: 10 },
      { name: 'currentTask', value: agent.currentTask, weight: 8 },
      { name: 'workspace', value: agent.workspace, weight: 4 },
      { name: 'branch', value: agent.branch, weight: 4 },
      ...(agent.aliases ?? []).map((alias) => ({ name: 'alias', value: alias, weight: 12 })),
    ],
  };
}

function scoreAgent(
  agent: AddressableFleetAgent,
  reference: string,
  tokens: readonly string[],
): AgentAddressCandidate | null {
  const normalizedReference = normalizeReference(reference);
  const { label, fields } = candidateFields(agent);
  let score = 0;
  const matchedFields = new Set<string>();

  for (const field of fields) {
    const normalized = normalizeReference(field.value ?? '');
    if (!normalized) continue;
    if (normalized === normalizedReference) {
      score += 100;
      matchedFields.add(field.name);
      continue;
    }
    if (normalizedReference && normalized.includes(normalizedReference)) {
      score += field.weight * 3;
      matchedFields.add(field.name);
    }
    for (const token of tokens) {
      if (normalized.split(' ').some((part) => part === token || part.startsWith(token))) {
        score += field.weight;
        matchedFields.add(field.name);
      }
    }
  }

  if (score === 0) return null;
  return {
    agentId: agent.id,
    laneId: agent.laneId ?? null,
    packetId: agent.packetId ?? null,
    label,
    score,
    matchedFields: [...matchedFields],
  };
}

export function resolveAgentReference(
  reference: string,
  agents: readonly AddressableFleetAgent[],
): AgentAddressResolution {
  const tokens = referenceTokens(reference);
  if (tokens.length === 0 && !normalizeReference(reference)) {
    return {
      match: null,
      candidates: [],
      disambiguationPrompt: 'Which agent do you mean?',
    };
  }

  const candidates = agents
    .map((agent) => scoreAgent(agent, reference, tokens))
    .filter((candidate): candidate is AgentAddressCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 5);

  if (candidates.length === 0) {
    return {
      match: null,
      candidates: [],
      disambiguationPrompt: `I couldn't match “${reference.trim()}” to an active agent.`,
    };
  }

  const top = candidates[0];
  const competing = candidates.filter((candidate) => top.score - candidate.score <= 2);
  if (competing.length > 1) {
    return {
      match: null,
      candidates,
      disambiguationPrompt: `I found multiple matches: ${competing.map((candidate) => candidate.label).join(' or ')}. Which one?`,
    };
  }

  return {
    match: top,
    candidates,
    disambiguationPrompt: null,
  };
}

