import fs from 'node:fs';

import { treatmentForCondition, type CodingCondition } from './coding';
import type { ArmClassification, ArmOutcome } from './coding-arm-outcome';

interface CommandEvidence {
  status: number | null;
}

export interface PairedArmEvidence {
  condition: CodingCondition;
  treatment: 'raw' | 'contract';
  outcome: ArmOutcome;
  terminalStatus: ArmClassification['terminalStatus'];
  classificationReason?: string;
  diffPath: string;
  changedFiles: string[];
  contractObserved: boolean | null;
  send: CommandEvidence;
  mechanical: {
    typecheck: CommandEvidence;
    eslint: CommandEvidence | null;
    lintedFiles: string[];
  };
  measurementNotes?: string[];
}

export interface CollectedPairedArmClassification extends ArmClassification {
  terminalOutcome: ArmOutcome;
  terminalClassificationReason: string;
  pairedAcceptance: PairedArmAcceptanceReceipt;
}

export interface PairedArmAcceptanceReceipt {
  condition: string;
  accepted: boolean;
  recordedOutcome: ArmOutcome;
  terminalStatus: PairedArmEvidence['terminalStatus'];
  diffPath: string;
  reasons: string[];
}

export interface PairedTaskAcceptanceReceipt {
  task: number;
  complete: boolean;
  reasons: string[];
  arms: PairedArmAcceptanceReceipt[];
}

function diffFailure(diffPath: string): string | null {
  try {
    if (!fs.existsSync(diffPath)) return 'diff artifact is missing';
    return fs.readFileSync(diffPath, 'utf8').trim().length > 0
      ? null
      : 'diff artifact is empty';
  } catch {
    return 'diff artifact could not be read';
  }
}

export function assessPairedArmAcceptance(input: PairedArmEvidence): PairedArmAcceptanceReceipt {
  const reasons: string[] = [];
  const expectedTreatment = treatmentForCondition(input.condition);
  if (input.terminalStatus !== 'completed') {
    reasons.push(`worker terminal status ${input.terminalStatus ?? 'was not observed'}`);
  }
  if (input.send.status !== 0) reasons.push(`worker turn command failed with status ${input.send.status ?? 'null'}`);
  if (input.outcome === 'invalid') {
    reasons.push(`recorded arm outcome is invalid: ${input.classificationReason ?? 'no reason recorded'}`);
  } else if (input.outcome === 'failed' && input.terminalStatus === 'completed') {
    reasons.push(`recorded arm outcome is failed: ${input.classificationReason ?? 'no reason recorded'}`);
  }
  if (input.changedFiles.length === 0) reasons.push('no diff produced');
  const diffReason = diffFailure(input.diffPath);
  if (diffReason) reasons.push(diffReason);
  if (input.treatment !== expectedTreatment) {
    reasons.push(`condition/treatment mismatch: ${input.condition} requires ${expectedTreatment}`);
  }
  if (expectedTreatment === 'contract' && input.contractObserved !== true) {
    reasons.push('treatment contract was not observed');
  }
  if (input.mechanical.typecheck.status !== 0) reasons.push('typecheck failed');
  if (input.mechanical.lintedFiles.length > 0 && input.mechanical.eslint === null) {
    reasons.push('touched-file eslint was not run');
  } else if (input.mechanical.eslint?.status !== undefined && input.mechanical.eslint.status !== 0) {
    reasons.push('touched-file eslint failed');
  }
  const noteFailures = new Map([
    ['worker spawn failed', 'worker spawn failed'],
    ['worker turn failed', 'worker turn failed'],
    ['no diff produced', 'no diff produced'],
    ['typecheck failed', 'typecheck failed'],
    ['eslint failed', 'touched-file eslint failed'],
  ]);
  for (const note of input.measurementNotes ?? []) {
    const known = noteFailures.get(note)
      ?? (note.startsWith('task contract artifact ') ? 'treatment contract was not observed' : null);
    if (known && !reasons.includes(known)) reasons.push(known);
  }
  return {
    condition: input.condition,
    accepted: reasons.length === 0,
    recordedOutcome: input.outcome,
    terminalStatus: input.terminalStatus,
    diffPath: input.diffPath,
    reasons,
  };
}

export function enforceCollectedPairedAcceptance(
  terminal: ArmClassification,
  evidence: Omit<PairedArmEvidence, 'outcome' | 'terminalStatus' | 'classificationReason'>,
): CollectedPairedArmClassification {
  const pairedAcceptance = assessPairedArmAcceptance({
    ...evidence,
    outcome: terminal.outcome,
    terminalStatus: terminal.terminalStatus,
    classificationReason: terminal.classificationReason,
  });
  return {
    ...terminal,
    terminalOutcome: terminal.outcome,
    terminalClassificationReason: terminal.classificationReason,
    outcome: pairedAcceptance.accepted ? 'valid' : 'invalid',
    classificationReason: pairedAcceptance.accepted
      ? 'paired acceptance passed'
      : `paired acceptance failed: ${pairedAcceptance.reasons.join('; ')}`,
    pairedAcceptance,
  };
}

export function selectCompletePairedTask<T extends PairedArmEvidence>(input: {
  task: number;
  conditions: readonly CodingCondition[];
  arms: Array<Omit<T, 'condition'> & { condition: string }>;
}): { receipt: PairedTaskAcceptanceReceipt; accepted: Partial<Record<CodingCondition, T>> } {
  const accepted: Partial<Record<CodingCondition, T>> = {};
  const armReceipts: PairedArmAcceptanceReceipt[] = [];
  const expectedConditions = new Set<string>(input.conditions);
  for (const arm of input.arms) {
    if (expectedConditions.has(arm.condition)) continue;
    armReceipts.push({
      condition: arm.condition,
      accepted: false,
      recordedOutcome: arm.outcome,
      terminalStatus: arm.terminalStatus,
      diffPath: arm.diffPath,
      reasons: [`unexpected condition: ${arm.condition}`],
    });
  }
  for (const condition of input.conditions) {
    const matches = input.arms.filter((arm) => arm.condition === condition);
    if (matches.length !== 1) {
      armReceipts.push({
        condition,
        accepted: false,
        recordedOutcome: matches[0]?.outcome ?? 'invalid',
        terminalStatus: matches[0]?.terminalStatus ?? null,
        diffPath: matches[0]?.diffPath ?? '',
        reasons: [matches.length === 0 ? 'arm receipt is missing' : `duplicate arm receipts: ${matches.length}`],
      });
      continue;
    }
    const arm = { ...matches[0], condition } as T;
    const receipt = assessPairedArmAcceptance(arm);
    armReceipts.push(receipt);
    if (receipt.accepted) accepted[condition] = arm;
  }
  const reasons = armReceipts.flatMap((arm) => arm.reasons.map((reason) => `${arm.condition}: ${reason}`));
  return {
    receipt: {
      task: input.task,
      complete: reasons.length === 0 && Object.keys(accepted).length === input.conditions.length,
      reasons,
      arms: armReceipts,
    },
    accepted,
  };
}
