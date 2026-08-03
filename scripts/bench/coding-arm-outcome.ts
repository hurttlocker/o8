export enum TurnStatus {
  Completed = 'completed',
  Interrupted = 'interrupted',
  Failed = 'failed',
  InProgress = 'inProgress',
}

export type ArmOutcome = 'valid' | 'failed' | 'invalid';
export type ArmResultSource = 'stream' | 'durable-state-reconciliation';

export interface ArmErrorReceipt {
  message: string;
  willRetry: boolean;
}

export interface ArmClassification {
  outcome: ArmOutcome;
  terminalStatus: TurnStatus.Completed | TurnStatus.Interrupted | TurnStatus.Failed | null;
  classificationReason: string;
  resultSource: ArmResultSource;
  errors: ArmErrorReceipt[];
}

export interface ArmOutcomeTotals {
  valid: number;
  failed: number;
  invalid: number;
}

function noTerminalReason(status: TurnStatus.InProgress | null, errors: ArmErrorReceipt[]): string {
  const nonRetryable = errors.find((error) => !error.willRetry);
  if (nonRetryable) return `no terminal event observed after non-retryable error: ${nonRetryable.message}`;
  if (status === TurnStatus.InProgress) return 'no terminal event observed; last status was inProgress';
  return 'no terminal event observed';
}

export function classifyArmStatus(input: {
  status: TurnStatus | null;
  source: ArmResultSource;
  errors?: ArmErrorReceipt[];
}): ArmClassification {
  const errors = input.errors ?? [];
  if (input.status === null) {
    return {
      outcome: 'invalid',
      terminalStatus: null,
      classificationReason: noTerminalReason(null, errors),
      resultSource: input.source,
      errors,
    };
  }

  switch (input.status) {
    case TurnStatus.Completed:
      return {
        outcome: 'valid',
        terminalStatus: TurnStatus.Completed,
        classificationReason: 'terminal status completed',
        resultSource: input.source,
        errors,
      };
    case TurnStatus.Failed:
      return {
        outcome: 'failed',
        terminalStatus: TurnStatus.Failed,
        classificationReason: 'terminal status failed',
        resultSource: input.source,
        errors,
      };
    case TurnStatus.Interrupted:
      return {
        outcome: 'invalid',
        terminalStatus: TurnStatus.Interrupted,
        classificationReason: 'terminal status interrupted; interruption is not a failure',
        resultSource: input.source,
        errors,
      };
    case TurnStatus.InProgress:
      return {
        outcome: 'invalid',
        terminalStatus: null,
        classificationReason: noTerminalReason(TurnStatus.InProgress, errors),
        resultSource: input.source,
        errors,
      };
  }
  const exhaustive: never = input.status;
  throw new Error(`unclassified turn status: ${String(exhaustive)}`);
}

export function isScorableArmOutcome(outcome: ArmOutcome): boolean {
  switch (outcome) {
    case 'valid':
    case 'failed':
      return true;
    case 'invalid':
      return false;
  }
  const exhaustive: never = outcome;
  throw new Error(`unclassified arm outcome: ${String(exhaustive)}`);
}

export function countArmOutcomes(arms: Array<{ outcome: ArmOutcome }>): ArmOutcomeTotals {
  const totals: ArmOutcomeTotals = { valid: 0, failed: 0, invalid: 0 };
  for (const arm of arms) {
    switch (arm.outcome) {
      case 'valid':
        totals.valid += 1;
        continue;
      case 'failed':
        totals.failed += 1;
        continue;
      case 'invalid':
        totals.invalid += 1;
        continue;
    }
    const exhaustive: never = arm.outcome;
    throw new Error(`unclassified arm outcome: ${String(exhaustive)}`);
  }
  return totals;
}

export function ginsuTurnStatus(input: {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): TurnStatus | null {
  if (input.timedOut || /timed out|died mid-turn|isn't running|before finishing/i.test(input.stderr)) {
    return null;
  }
  if (input.signal) return TurnStatus.Interrupted;
  if (input.status === 0) return TurnStatus.Completed;
  if (typeof input.status === 'number' && /turn failed \(exit \d+\)/i.test(input.stdout)) {
    return TurnStatus.Failed;
  }
  return null;
}
