export const ANTHROPIC_TASK_BUDGETS_BY_PHASE = {
  synthesis: 100_000,
  review: 50_000,
  merge: 25_000,
} as const;

export type AnthropicTaskPhase = keyof typeof ANTHROPIC_TASK_BUDGETS_BY_PHASE;

export type ResolvedAnthropicTaskBudget = {
  taskBudget: number;
  phase?: AnthropicTaskPhase;
  source: 'explicit' | 'phase_default';
};

export type AnthropicStopMetadata = {
  stopReason?: string;
  stopSequence?: string | null;
};

type BudgetEnvelope = {
  taskBudget?: unknown;
  task_budget?: unknown;
  taskPhase?: unknown;
  phase?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTaskBudget(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseTaskPhase(value: unknown): AnthropicTaskPhase | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'synthesis' || normalized === 'review' || normalized === 'merge') {
    return normalized;
  }
  return null;
}

function listBudgetEnvelopes(payload: Record<string, unknown>): BudgetEnvelope[] {
  const envelopes: BudgetEnvelope[] = [payload];

  const anthropic = payload.anthropic;
  if (isRecord(anthropic)) {
    envelopes.push(anthropic);
  }

  const providerOptions = payload.providerOptions;
  if (isRecord(providerOptions)) {
    envelopes.push(providerOptions);
    if (isRecord(providerOptions.anthropic)) {
      envelopes.push(providerOptions.anthropic);
    }
  }

  return envelopes;
}

function invalidTaskBudgetResult() {
  return { value: null, error: 'Anthropic task_budget must be a positive integer.' };
}

function invalidTaskPhaseResult() {
  return { value: null, error: 'Anthropic taskPhase must be one of: synthesis, review, merge.' };
}

export function resolveAnthropicTaskBudget(
  payload: Record<string, unknown>,
): { value: ResolvedAnthropicTaskBudget | null; error?: string } {
  let phaseValue: unknown;

  for (const envelope of listBudgetEnvelopes(payload)) {
    const explicitBudget = envelope.taskBudget ?? envelope.task_budget;
    const explicitPhase = envelope.taskPhase ?? envelope.phase;

    if (explicitPhase !== undefined) {
      phaseValue = explicitPhase;
    }

    if (explicitBudget === undefined) {
      continue;
    }

    const taskBudget = parseTaskBudget(explicitBudget);
    if (taskBudget == null) {
      return invalidTaskBudgetResult();
    }

    if (explicitPhase === undefined) {
      return {
        value: {
          taskBudget,
          source: 'explicit',
        },
      };
    }

    const phase = parseTaskPhase(explicitPhase);
    if (!phase) {
      return invalidTaskPhaseResult();
    }

    return {
      value: {
        taskBudget,
        phase,
        source: 'explicit',
      },
    };
  }

  if (phaseValue === undefined) {
    return { value: null };
  }

  const phase = parseTaskPhase(phaseValue);
  if (!phase) {
    return invalidTaskPhaseResult();
  }

  return {
    value: {
      taskBudget: ANTHROPIC_TASK_BUDGETS_BY_PHASE[phase],
      phase,
      source: 'phase_default',
    },
  };
}

export function parseAnthropicStopMetadata(line: string): AnthropicStopMetadata | null {
  if (!line.startsWith('data: ')) {
    return null;
  }

  try {
    const payload = JSON.parse(line.slice(6).trim()) as {
      type?: string;
      delta?: Record<string, unknown>;
      message?: Record<string, unknown>;
    };
    const candidate = payload.type === 'message_delta'
      ? payload.delta
      : payload.type === 'message_start'
        ? payload.message
        : null;

    if (!candidate) {
      return null;
    }

    const stopReason = typeof candidate.stop_reason === 'string' ? candidate.stop_reason : undefined;
    const stopSequence = candidate.stop_sequence === null || typeof candidate.stop_sequence === 'string'
      ? candidate.stop_sequence
      : undefined;

    if (stopReason === undefined && stopSequence === undefined) {
      return null;
    }

    return { stopReason, stopSequence };
  } catch {
    return null;
  }
}
