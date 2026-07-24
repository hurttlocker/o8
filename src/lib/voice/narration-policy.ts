import type { AgentStatus } from '@/lib/fleet/types';
import type { FleetNarrationEvent, FleetNarrationKind } from './fleet-narration-events';
import {
  remainingVoiceSeconds,
  valuePerVoiceSecond,
  voiceBudgetRemainingRatio,
  wouldExceedVoiceBudget,
  type VoiceBudgetState,
} from './voice-budget';

export type NarrationTier = 'interrupt-now' | 'ambient-rollup' | 'on-demand';
export type NarrationAction = 'speak' | 'hold' | 'suppress';
export type NarrationSuppressionReason =
  | 'duplicate-state'
  | 'low-budget'
  | 'concurrency-ceiling'
  | 'on-demand-only';

export interface NarrationDecision {
  sourceEventIds: string[];
  agentLabel: string | null;
  tier: NarrationTier;
  action: NarrationAction;
  utterance: string;
  holdUntilPause: boolean;
  estimatedVoiceSeconds: number;
  valueScore: number;
  valuePerVoiceSecond: number;
  budgetWouldExceed: boolean;
  reason: string;
  suppressionReason: NarrationSuppressionReason | null;
  isFleetPointer: boolean;
}

export interface NarrationMemory {
  readonly [transitionKey: string]: string;
}

export interface NarrationFleetAgentState {
  id: string;
  status: AgentStatus;
}

export interface NarrationFleetState {
  agents: readonly NarrationFleetAgentState[];
  ambientCadenceDue?: boolean;
  onDemandRequested?: boolean;
  concurrencyCeiling?: number;
  lowBudgetThresholdRatio?: number;
}

export interface NarrationPolicyInput {
  events: readonly FleetNarrationEvent[];
  fleet: NarrationFleetState;
  budget: VoiceBudgetState;
  memory?: NarrationMemory;
}

export interface NarrationPolicyResult {
  decisions: NarrationDecision[];
  nextMemory: NarrationMemory;
  activeAgentCount: number;
  exceptionsOnly: boolean;
}

const INTERRUPT_KINDS = new Set<FleetNarrationKind>([
  'review-ready',
  'approval-needed',
  'escalation',
  'conflict',
  'failure',
  'blocked',
  'question',
]);

const AMBIENT_KINDS = new Set<FleetNarrationKind>([
  'retry',
  'merged',
  'completed',
  'changed-files',
  'interrupted',
  'launched',
]);

const KIND_VALUE: Record<FleetNarrationKind, number> = {
  failure: 100,
  conflict: 96,
  blocked: 92,
  escalation: 90,
  question: 88,
  'approval-needed': 86,
  'review-ready': 82,
  merged: 58,
  retry: 46,
  interrupted: 44,
  'changed-files': 36,
  completed: 32,
  launched: 24,
  progress: 14,
  other: 8,
};

const ACTIVE_AGENT_STATUSES = new Set<AgentStatus>([
  'running',
  'huddling',
  'blocked',
  'waiting',
  'reviewing',
]);

function tierForKind(kind: FleetNarrationKind): NarrationTier {
  if (INTERRUPT_KINDS.has(kind)) return 'interrupt-now';
  if (AMBIENT_KINDS.has(kind)) return 'ambient-rollup';
  return 'on-demand';
}

function estimateVoiceSeconds(utterance: string): number {
  const words = utterance.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(12, Math.max(1.5, Number((words / 2.6 + 0.35).toFixed(1))));
}

function activeAgentCount(fleet: NarrationFleetState): number {
  return fleet.agents.filter((agent) => ACTIVE_AGENT_STATUSES.has(agent.status)).length;
}

function latestTransitionEvents(
  events: readonly FleetNarrationEvent[],
): FleetNarrationEvent[] {
  const latest = new Map<string, { event: FleetNarrationEvent; index: number }>();
  events.forEach((event, index) => {
    const prior = latest.get(event.transitionKey);
    if (!prior) {
      latest.set(event.transitionKey, { event, index });
      return;
    }
    const priorTime = Date.parse(prior.event.occurredAt);
    const nextTime = Date.parse(event.occurredAt);
    if (
      (!Number.isNaN(nextTime) && (Number.isNaN(priorTime) || nextTime > priorTime))
      || nextTime === priorTime
      || (Number.isNaN(nextTime) && Number.isNaN(priorTime) && index > prior.index)
    ) {
      latest.set(event.transitionKey, { event, index });
    }
  });
  return [...latest.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ event }) => event);
}

function isLowBudget(fleet: NarrationFleetState, budget: VoiceBudgetState): boolean {
  const threshold = fleet.lowBudgetThresholdRatio ?? 0.1;
  return (
    voiceBudgetRemainingRatio(budget) <= threshold
    || remainingVoiceSeconds(budget) <= 60
  );
}

function baseDecision(
  event: FleetNarrationEvent,
  budget: VoiceBudgetState,
): NarrationDecision {
  const tier = tierForKind(event.kind);
  const utterance = `${event.agentLabel}: ${event.summary}`;
  const estimatedVoiceSeconds = estimateVoiceSeconds(utterance);
  const valueScore = KIND_VALUE[event.kind];
  return {
    sourceEventIds: [event.id],
    agentLabel: event.agentLabel,
    tier,
    action: tier === 'interrupt-now' ? 'speak' : 'hold',
    utterance,
    holdUntilPause: tier !== 'interrupt-now',
    estimatedVoiceSeconds,
    valueScore,
    valuePerVoiceSecond: valuePerVoiceSecond(valueScore, estimatedVoiceSeconds),
    budgetWouldExceed: wouldExceedVoiceBudget(budget, estimatedVoiceSeconds),
    reason: tier === 'interrupt-now'
      ? 'Blocking transition should interrupt immediately.'
      : tier === 'ambient-rollup'
        ? 'Non-blocking delta should wait for a narration pause or cadence.'
        : 'Low-value state is available on demand.',
    suppressionReason: null,
    isFleetPointer: false,
  };
}

function pointerDecision(
  activeCount: number,
  fleet: NarrationFleetState,
  budget: VoiceBudgetState,
): NarrationDecision {
  const utterance = `I'm tracking ${activeCount} active agents. I'll call out exceptions; ask me about the rest.`;
  const estimatedVoiceSeconds = estimateVoiceSeconds(utterance);
  const valueScore = 28;
  return {
    sourceEventIds: [],
    agentLabel: null,
    tier: 'ambient-rollup',
    action: fleet.ambientCadenceDue ? 'speak' : 'hold',
    utterance,
    holdUntilPause: true,
    estimatedVoiceSeconds,
    valueScore,
    valuePerVoiceSecond: valuePerVoiceSecond(valueScore, estimatedVoiceSeconds),
    budgetWouldExceed: wouldExceedVoiceBudget(budget, estimatedVoiceSeconds),
    reason: 'Fleet concurrency exceeded the ambient narration ceiling.',
    suppressionReason: null,
    isFleetPointer: true,
  };
}

export function decideFleetNarration(
  input: NarrationPolicyInput,
): NarrationPolicyResult {
  const activeCount = activeAgentCount(input.fleet);
  const ceiling = input.fleet.concurrencyCeiling ?? 6;
  const exceptionsOnly = activeCount > ceiling;
  const lowBudget = isLowBudget(input.fleet, input.budget);
  const nextMemory: Record<string, string> = { ...(input.memory ?? {}) };
  const decisions: NarrationDecision[] = [];
  let ambientSuppressedByCeiling = false;

  for (const event of latestTransitionEvents(input.events)) {
    const decision = baseDecision(event, input.budget);
    const duplicate = !event.isTransition
      || nextMemory[event.transitionKey] === event.transitionState;
    nextMemory[event.transitionKey] = event.transitionState;

    if (duplicate) {
      decisions.push({
        ...decision,
        action: 'suppress',
        reason: 'The same semantic state was already narrated.',
        suppressionReason: 'duplicate-state',
      });
      continue;
    }

    if (lowBudget && decision.tier !== 'interrupt-now') {
      decisions.push({
        ...decision,
        action: 'suppress',
        reason: 'Voice-time budget is low; only blocking transitions survive.',
        suppressionReason: 'low-budget',
      });
      continue;
    }

    if (exceptionsOnly && decision.tier === 'ambient-rollup') {
      ambientSuppressedByCeiling = true;
      decisions.push({
        ...decision,
        action: 'suppress',
        reason: `Fleet has ${activeCount} active agents; ambient narration is exceptions-only.`,
        suppressionReason: 'concurrency-ceiling',
      });
      continue;
    }

    if (decision.tier === 'ambient-rollup') {
      decisions.push({
        ...decision,
        action: input.fleet.ambientCadenceDue ? 'speak' : 'hold',
      });
      continue;
    }

    if (decision.tier === 'on-demand') {
      decisions.push({
        ...decision,
        action: input.fleet.onDemandRequested ? 'speak' : 'suppress',
        reason: input.fleet.onDemandRequested
          ? 'The operator requested the current fleet state.'
          : 'This state stays silent until the operator asks.',
        suppressionReason: input.fleet.onDemandRequested ? null : 'on-demand-only',
      });
      continue;
    }

    decisions.push(decision);
  }

  const pointerState = `exceptions-only-${activeCount}`;
  if (
    ambientSuppressedByCeiling
    && nextMemory['fleet:exceptions-only'] !== pointerState
  ) {
    nextMemory['fleet:exceptions-only'] = pointerState;
    const pointer = pointerDecision(activeCount, input.fleet, input.budget);
    decisions.push(lowBudget
      ? {
          ...pointer,
          action: 'suppress',
          reason: 'Voice-time budget is low; even the fleet pointer is held back.',
          suppressionReason: 'low-budget',
        }
      : pointer);
  }

  return {
    decisions,
    nextMemory,
    activeAgentCount: activeCount,
    exceptionsOnly,
  };
}

export function rankByValuePerVoiceSecond(
  decisions: readonly NarrationDecision[],
): NarrationDecision[] {
  return [...decisions].sort((left, right) => (
    right.valuePerVoiceSecond - left.valuePerVoiceSecond
    || right.valueScore - left.valueScore
    || left.estimatedVoiceSeconds - right.estimatedVoiceSeconds
  ));
}
