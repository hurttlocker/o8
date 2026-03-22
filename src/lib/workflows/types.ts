import type { RuntimeKind } from '@/lib/runtime/adapter';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type WorkflowRunStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_for_human'
  | 'blocked'
  | 'needs_context'
  | 'done'
  | 'done_with_concerns'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export type WorkflowStageStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_for_human'
  | 'blocked'
  | 'needs_context'
  | 'done'
  | 'done_with_concerns'
  | 'skipped'
  | 'failed';

export type WorkflowTerminalStatus = Extract<
  WorkflowStageStatus,
  'done' | 'done_with_concerns' | 'blocked' | 'needs_context' | 'skipped' | 'failed'
>;

export type WorkflowStageKind =
  | 'ingest'
  | 'gather'
  | 'triage'
  | 'approval'
  | 'plan'
  | 'build'
  | 'review'
  | 'test'
  | 'ship'
  | 'close'
  | 'notify';

export type WorkflowStageExecutor = 'system' | 'agent' | 'human';

export type WorkflowTriggerSource =
  | 'manual'
  | 'api'
  | 'github'
  | 'sentry'
  | 'schedule'
  | 'workflow';

export type WorkflowCapability =
  | 'read_repo'
  | 'read_git'
  | 'read_issue_tracker'
  | 'write_issue_tracker'
  | 'read_sentry'
  | 'read_deploy_state'
  | 'edit_code'
  | 'run_tests'
  | 'review_diff'
  | 'create_branch'
  | 'create_commit'
  | 'create_pr'
  | 'close_issue'
  | 'request_human_input'
  | 'attach_evidence'
  | 'browse_app';

export type WorkflowArtifactKind =
  | 'event'
  | 'incident'
  | 'note'
  | 'log_bundle'
  | 'trace_bundle'
  | 'repo_snapshot'
  | 'plan'
  | 'patch'
  | 'diff'
  | 'test_report'
  | 'review_report'
  | 'pull_request'
  | 'issue'
  | 'closure_note';

export type WorkflowArtifactStatus = 'missing' | 'ready' | 'stale' | 'failed';

export type WorkflowArtifactCardinality = 'one' | 'many';

export type WorkflowArtifactRetention = 'run' | 'workflow' | 'forever';

export type WorkflowEvidenceKind =
  | 'sentry_event'
  | 'sentry_issue'
  | 'stacktrace'
  | 'trace'
  | 'log'
  | 'commit'
  | 'diff'
  | 'test_output'
  | 'link'
  | 'note';

export type WorkflowApprovalPolicy = 'auto' | 'ask' | 'required' | 'forbidden';

export type WorkflowApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'skipped';

export type WorkflowDecisionMode = 'single' | 'multi';

export type WorkflowDecisionActor = 'system' | 'agent' | 'human';

export type WorkflowReviewKind = 'agent' | 'human' | 'policy' | 'test';

export type WorkflowReviewStatus =
  | 'pending'
  | 'passed'
  | 'changes_requested'
  | 'waived';

export interface WorkflowEventTriggerDefinition {
  kind: 'event';
  source: Exclude<WorkflowTriggerSource, 'manual' | 'schedule'>;
  eventTypes: string[];
  dedupeKeyTemplate: string;
  filters?: JsonObject;
}

export interface WorkflowManualTriggerDefinition {
  kind: 'manual';
  source: 'manual';
  defaultInput?: JsonObject;
}

export interface WorkflowScheduleTriggerDefinition {
  kind: 'schedule';
  source: 'schedule';
  cron: string;
  timezone?: string;
}

export type WorkflowTriggerDefinition =
  | WorkflowEventTriggerDefinition
  | WorkflowManualTriggerDefinition
  | WorkflowScheduleTriggerDefinition;

export interface WorkflowTriggerEvent {
  source: WorkflowTriggerSource;
  eventType: string;
  receivedAt: string;
  dedupeKey?: string;
  summary: string;
  payload?: JsonObject;
}

export interface WorkflowCapabilityRequirement {
  capability: WorkflowCapability;
  importance: 'required' | 'preferred';
  reason?: string;
}

export interface WorkflowRuntimeAssignment {
  strategy: 'fixed' | 'prefer' | 'first_supported' | 'manual';
  allowedRuntimes: RuntimeKind[];
  preferredRuntimes?: RuntimeKind[];
  capabilityRequirements: WorkflowCapabilityRequirement[];
  sticky?: boolean;
}

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  retryOn?: string[];
  resetOnManualRetry?: boolean;
}

export interface WorkflowEscalationPolicy {
  afterAttempts: number;
  setRunStatus: Extract<WorkflowRunStatus, 'waiting_for_human' | 'blocked' | 'needs_context'>;
  notify: Array<'operator' | 'workflow_owner' | 'incident_channel'>;
  summary: string;
  createApproval?: boolean;
}

export interface WorkflowArtifactDefinition {
  key: string;
  kind: WorkflowArtifactKind;
  title: string;
  required: boolean;
  cardinality: WorkflowArtifactCardinality;
  retention: WorkflowArtifactRetention;
  producedBy?: string[];
  consumedBy?: string[];
  schema?: JsonObject;
}

export interface WorkflowDecisionOption {
  id: string;
  label: string;
  description: string;
  nextStageId?: string;
  terminalOutcomeCode?: string;
  recommended?: boolean;
}

export interface WorkflowDecisionTemplate {
  id: string;
  title: string;
  summary: string;
  mode: WorkflowDecisionMode;
  required: boolean;
  decidedBy: WorkflowDecisionActor;
  options: WorkflowDecisionOption[];
  evidenceKinds?: WorkflowEvidenceKind[];
}

export interface WorkflowApprovalTemplate {
  id: string;
  policy: WorkflowApprovalPolicy;
  title: string;
  summary: string;
  approverRoles?: string[];
  timeoutMinutes?: number;
  onRejectStageId?: string;
  onRejectOutcomeCode?: string;
}

export interface WorkflowReviewRequirement {
  id: string;
  kind: WorkflowReviewKind;
  title: string;
  summary?: string;
  blocking: boolean;
  checklist?: string[];
  requiredCapabilities?: WorkflowCapability[];
}

export type WorkflowTransitionCondition =
  | {
      kind: 'stage_status';
      status: WorkflowTerminalStatus;
    }
  | {
      kind: 'decision';
      decisionId: string;
      optionId: string;
    }
  | {
      kind: 'approval';
      approvalId: string;
      status: WorkflowApprovalStatus;
    }
  | {
      kind: 'artifact_present';
      artifactKey: string;
    };

export interface WorkflowTransition {
  from: string;
  to: string;
  when: WorkflowTransitionCondition;
}

export interface WorkflowOutcomeDefinition {
  code: string;
  status: Extract<
    WorkflowRunStatus,
    'done' | 'done_with_concerns' | 'blocked' | 'needs_context' | 'failed' | 'cancelled'
  >;
  title: string;
  summary: string;
}

export interface WorkflowStageTemplate {
  id: string;
  title: string;
  kind: WorkflowStageKind;
  executor: WorkflowStageExecutor;
  summary: string;
  dependsOn?: string[];
  consumes?: string[];
  produces?: string[];
  runtimeAssignment?: WorkflowRuntimeAssignment;
  approvals?: WorkflowApprovalTemplate[];
  decisions?: WorkflowDecisionTemplate[];
  reviews?: WorkflowReviewRequirement[];
  retryPolicy?: WorkflowRetryPolicy;
  escalationPolicy?: WorkflowEscalationPolicy;
  terminalOutcomeCode?: string;
  notes?: string[];
}

export interface WorkflowTemplate {
  kind: 'workflow_template';
  schemaVersion: '1';
  id: string;
  version: number;
  title: string;
  summary: string;
  description?: string;
  tags?: string[];
  trigger: WorkflowTriggerDefinition;
  initialStageId: string;
  artifacts: WorkflowArtifactDefinition[];
  stages: WorkflowStageTemplate[];
  transitions: WorkflowTransition[];
  outcomes: WorkflowOutcomeDefinition[];
  metadata?: JsonObject;
}

export interface WorkflowEvidence {
  id: string;
  kind: WorkflowEvidenceKind;
  title: string;
  source: WorkflowTriggerSource | 'runtime' | 'operator';
  capturedAt: string;
  artifactKey?: string;
  uri?: string;
  metadata?: JsonObject;
}

export interface WorkflowArtifactRecord {
  key: string;
  kind: WorkflowArtifactKind;
  status: WorkflowArtifactStatus;
  version: number;
  uri?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: JsonObject;
}

export interface WorkflowDecisionRecord {
  decisionId: string;
  selectedOptionIds: string[];
  decidedBy: WorkflowDecisionActor;
  decidedAt: string;
  rationale?: string;
}

export interface WorkflowApprovalRecord {
  approvalId: string;
  status: WorkflowApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  notes?: string;
}

export interface WorkflowReviewRecord {
  reviewId: string;
  stageId: string;
  kind: WorkflowReviewKind;
  status: WorkflowReviewStatus;
  reviewer?: string;
  createdAt: string;
  resolvedAt?: string;
  notes?: string;
}

export interface WorkflowRuntimeBinding {
  stageId: string;
  runtime: RuntimeKind;
  assignedAt: string;
  reason?: string;
}

export interface WorkflowStageRun {
  stageId: string;
  status: WorkflowStageStatus;
  executor: WorkflowStageExecutor;
  runtime?: RuntimeKind;
  attemptCount: number;
  startedAt?: string;
  finishedAt?: string;
  inputArtifactKeys: string[];
  outputArtifactKeys: string[];
  note?: string;
}

export interface WorkflowOutcome {
  code: string;
  status: Extract<
    WorkflowRunStatus,
    'done' | 'done_with_concerns' | 'blocked' | 'needs_context' | 'failed' | 'cancelled'
  >;
  summary: string;
  artifactKeys: string[];
  nextAction?: string;
}

export interface WorkflowRun {
  id: string;
  templateId: string;
  templateVersion: number;
  status: WorkflowRunStatus;
  triggerEvent: WorkflowTriggerEvent;
  createdAt: string;
  updatedAt: string;
  currentStageId?: string;
  stageRuns: WorkflowStageRun[];
  runtimeAssignments: WorkflowRuntimeBinding[];
  artifacts: WorkflowArtifactRecord[];
  evidence: WorkflowEvidence[];
  decisions: WorkflowDecisionRecord[];
  approvals: WorkflowApprovalRecord[];
  reviews: WorkflowReviewRecord[];
  outcome?: WorkflowOutcome;
}
