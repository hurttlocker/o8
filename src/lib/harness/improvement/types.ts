/** Experiment artifacts are advisory. None of these types conveys launch or merge authority. */
export interface ImprovementHarness {
  instructions: string;
  memory?: string;
  skills?: string;
  toolGuidance?: string;
}
export interface ImprovementManifest {
  id: string;
  repository: string;
  baselineRevision: string;
  contractDigest: string;
  verifierDigest: string;
  permissionsDigest: string;
  runtime: string;
  model: string;
  effort: string;
  provenance: 'fixture' | 'native';
  mode: 'parallel' | 'sequential';
  k: number;
  maxStages: number;
  maxStageWallMs: number;
  maxInputBytes: number;
  baseline: ImprovementHarness;
  tasks: Array<{ id: string; domain: string; prompt: string }>;
}
export type ImprovementStageKind = 'execute' | 'propose_invariant' | 'propose_domain' | 'compose' | 'select' | 'reflect';
export interface BehavioralEvidence {
  requestId: string;
  label: string;
  harness: ImprovementHarness;
  artifact: string;
  trajectory: string;
}
export interface ImprovementLesson {
  id: string;
  scopeDigest: string;
  sourceTaskId: string;
  sourceTaskIndex: number;
  domain: string;
  sourceRequestIds: string[];
  text: string;
  expiresAfterTask: number;
  revoked: boolean;
  adoptedHarness: ImprovementHarness;
  adoptedHarnessDigest: string;
}
export interface ImprovementRequest {
  id: string;
  manifestDigest: string;
  taskId: string;
  kind: ImprovementStageKind;
  label: string;
  prompt: string;
  harness: ImprovementHarness;
  evidence: BehavioralEvidence[];
  lessons: ImprovementLesson[];
  choices: Array<{ id: string; artifact: string }>;
  maxWallMs: number;
}
export interface ImprovementUsage {
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  actualUsd: number | null;
  estimatedUsd: number | null;
  wallMs: number;
  humanMs: number | null;
  billing: 'subscription' | 'api' | 'unknown';
}
export interface ImprovementReceipt {
  requestId: string;
  requestDigest: string;
  status: 'completed' | 'failed' | 'uncertain';
  provenance: 'fixture' | 'native';
  runtime: string;
  model: string;
  effort: string;
  failureReason?: 'invalid_stage_output';
  harness?: ImprovementHarness;
  artifact?: string;
  trajectory?: string;
  choice?: string;
  decisions?: Array<{ action: 'preserve' | 'adopt' | 'revise'; rationale: string; sourceRequestIds: string[] }>;
  lesson?: { text: string; sourceRequestIds: string[]; expiresAfterTask: number };
  usage: ImprovementUsage;
}
export interface ImprovementRecord {
  request: ImprovementRequest;
  receipt: ImprovementReceipt;
}
/** A permanent retraction at an exact quiescent point in the settled record history. */
export interface ImprovementLessonRevocation {
  lessonId: string;
  lessonDigest: string;
  scopeDigest: string;
  afterRecordCount: number;
  reason: string;
}
export interface ImprovementExperiment {
  schema: 'o8/harness-refinement/v1';
  manifest: ImprovementManifest;
  manifestDigest: string;
  scopeDigest: string;
  revision: number;
  taskIndex: number;
  status: 'ready' | 'pending' | 'blocked' | 'completed';
  blockedReason: string | null;
  pending: ImprovementRequest | null;
  pendingReceipt: ImprovementReceipt | null;
  records: ImprovementRecord[];
  lessons: ImprovementLesson[];
  lessonRevocations: ImprovementLessonRevocation[];
  selections: Array<{ taskId: string; requestId: string; fallback: boolean }>;
  acceptance: { liveBenefitProven: false; promoted: false };
}
