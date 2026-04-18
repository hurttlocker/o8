'use client';

import { useEffect, useState } from 'react';
import { estimateAnthropicInputCostUsd } from '@/lib/llm/pricing';
import {
  ORCHESTRATOR_CONTEXT_LIMIT,
  ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS,
  ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS,
  approxTokens,
} from './use-orchestrator-stream/shared';

const INPUT_DEBOUNCE_MS = 200;

export interface TokenEstimateSnapshot {
  costUsd: number | null;
  projectedPercent: number;
  projectedTokens: number;
  warnAtContextThreshold: boolean;
}

export function useTokenEstimate({
  enabled,
  input,
  model,
  runningTotal,
}: {
  enabled: boolean;
  input: string;
  model: string;
  runningTotal: number;
}): TokenEstimateSnapshot | null {
  const [debouncedInput, setDebouncedInput] = useState(input);

  useEffect(() => {
    const nextValue = !enabled || !input.trim() ? '' : input;
    const timer = window.setTimeout(() => {
      setDebouncedInput(nextValue);
    }, nextValue ? INPUT_DEBOUNCE_MS : 0);

    return () => window.clearTimeout(timer);
  }, [enabled, input]);

  const normalizedInput = debouncedInput.trim();
  if (!enabled || !normalizedInput) return null;

  // Keep the footer preview aligned with the stream's next-turn heuristic
  // without reaching back into the stream controller layer.
  const projectedTokens = runningTotal
    + ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS
    + ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS
    + approxTokens(normalizedInput);
  const projectedPercent = Math.round(
    (Math.max(0, Math.min(ORCHESTRATOR_CONTEXT_LIMIT, projectedTokens)) / ORCHESTRATOR_CONTEXT_LIMIT) * 100,
  );

  return {
    costUsd: estimateAnthropicInputCostUsd(model, projectedTokens),
    projectedPercent,
    projectedTokens,
    warnAtContextThreshold: projectedTokens >= ORCHESTRATOR_CONTEXT_LIMIT * 0.6,
  };
}
