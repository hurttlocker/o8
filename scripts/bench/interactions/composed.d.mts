export interface TerminalWorkloadComposition {
  source: string;
  status: 'pass' | 'fail' | 'historical' | 'unavailable';
  budgetStatus?: 'pass' | 'fail';
  provenance?: 'current-build' | 'historical';
  currentBuildProof?: boolean;
  unavailableReason?: string;
  generatedAt?: string | null;
  commit?: string | null;
  dirty?: boolean | null;
  buildMode?: string | null;
  provenanceNote?: string;
  budgetFailures?: string[];
  lockedBudgets?: Record<string, number>;
  rapidSwitch?: { samples: number; allPassed: boolean };
  coverage: Record<string, unknown> | null;
}

export const TERMINAL_WORKLOAD_RECEIPT: string;

export function summarizeTerminalWorkload(
  receipt: unknown,
  options?: { measuredTarget?: { appVersion?: string | null; buildGitSha?: string | null } | null; receiptPath?: string },
): TerminalWorkloadComposition;
export function readTerminalWorkloadComposition(
  root: string,
  options?: { measuredTarget?: { appVersion?: string | null; buildGitSha?: string | null } | null; receiptPath?: string },
): TerminalWorkloadComposition;
