import type { CodingCondition, CodingRuntime } from './coding';
import type { ArmClassification, ArmOutcomeTotals } from './coding-arm-outcome';
import type { CodingCommandReceipt } from './coding-command';
import type { CodingEndToEndNotCollectedReceipt } from './coding-paired-plan';
import type { PairedMechanicalReceipt } from './coding-paired-mechanical';
import type { PairedDependencyPreparationReceipt } from './coding-paired-worktree';
import type { CodingRequestedSettings, CodingRuntimeConfig } from './coding-runtime-config';
import type { PairedArmAcceptanceReceipt } from './coding-paired-acceptance';
import type { BenchmarkRunControlReceipt } from './coding-run-control';
import type { EndToEndCollectionReceipt } from './run-coding-end-to-end';

export interface CodingPairedArmReceipt extends ArmClassification {
  task: number;
  condition: CodingCondition;
  runtime: CodingRuntime;
  requestedSettings: CodingRequestedSettings;
  treatment: 'raw' | 'contract';
  base: string;
  worktree: string;
  promptPath: string;
  replyPath: string;
  diffPath: string;
  worker: string;
  dependencies: PairedDependencyPreparationReceipt;
  turns: 1;
  repairTurns: 0;
  operatorInterventions: 0;
  timeoutSeconds: number;
  spawn: CodingCommandReceipt;
  send: CodingCommandReceipt;
  stop: CodingCommandReceipt;
  contractObserved: boolean | null;
  changedFiles: string[];
  additions: number;
  deletions: number;
  mechanical: PairedMechanicalReceipt;
  terminalOutcome: ArmClassification['outcome'];
  terminalClassificationReason: string;
  pairedAcceptance: PairedArmAcceptanceReceipt;
  measurementNotes: string[];
}

export type CodingCollectionPhase = 'paired-only' | 'full';

export interface CodingCollectionReceipt {
  schema: 'o8/coding-collection/v2' | 'o8/coding-collection/v3';
  runId: string;
  phase?: CodingCollectionPhase;
  createdAt: string;
  seed: number;
  armTimeoutSeconds: number;
  conditions: CodingCondition[];
  requestedSettings?: CodingRuntimeConfig;
  arms: CodingPairedArmReceipt[];
  outcomeTotals: ArmOutcomeTotals;
  endToEnd: EndToEndCollectionReceipt | CodingEndToEndNotCollectedReceipt;
  runControl: BenchmarkRunControlReceipt;
}
