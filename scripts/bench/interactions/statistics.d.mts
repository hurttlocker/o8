export interface Distribution {
  samples: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  note?: string;
}

export interface PhaseValue {
  value: number | null;
  note?: string;
  samples?: number;
}

export interface InteractionSample {
  durationMs?: number | null;
  note?: string;
  phases?: Record<string, PhaseValue | number | null | undefined>;
  censoredLowerBound?: boolean;
}

export interface ScenarioResult {
  distribution: Distribution;
  phases: Record<string, PhaseValue>;
  unavailableReason: string | null;
  censoredLowerBounds: number;
  lowerBoundNote?: string;
}

export function percentile(values: Array<number | null | undefined>, quantile: number): number | null;
export function distribution(values: Array<number | null | undefined>, options?: { note?: string | null }): Distribution;
export function summarizePhases(samples: InteractionSample[], phaseNames: string[]): Record<string, PhaseValue>;
export function scenarioResult(input: {
  samples?: InteractionSample[];
  phaseNames?: string[];
  unavailableReason?: string | null;
}): ScenarioResult;
