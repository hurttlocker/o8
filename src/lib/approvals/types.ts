import type { EventSeverity } from '@/lib/fleet/types';
import type { MobileTranscriptSource, MobileTranscriptToolCall } from '@/lib/mobile/types';

export type ApprovalRisk = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalActor = 'system' | 'desktop' | 'mobile' | 'orchestrator' | 'test';
export type ApprovalSource = 'llm-chat' | 'runtime' | 'test';

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  risk: ApprovalRisk;
  blocked?: boolean;
  workspacePath?: string;
  enabled?: boolean;
  requiresApproval?: boolean;
}

export interface PolicyRuleOverride {
  id: string;
  name?: string;
  description?: string;
  risk?: ApprovalRisk;
  blocked?: boolean;
  workspacePath?: string;
  enabled?: boolean;
  requiresApproval?: boolean;
}

export interface ApprovalDiffPreview {
  before?: string;
  after?: string;
  path?: string;
  files?: Array<{
    path: string;
    status: 'A' | 'M' | 'D' | 'R';
    patch: string;
  }>;
}

export interface OrchestratorReviewFinding {
  file: string;
  line?: number;
  severity: 'bug' | 'rule_violation' | 'note';
  description: string;
  resolution: 'fixed' | 'accepted' | 'deferred';
}

export interface ApprovalAuditEvent {
  type: 'created' | 'updated' | 'approved' | 'rejected' | 'resumed' | 'resume_failed' | 'orchestrator_review';
  actor: ApprovalActor;
  timestamp: number;
  note?: string;
  findings?: OrchestratorReviewFinding[];
  reviewer?: string;
  approved?: boolean;
  diffSha?: string;
  patterns?: string[];
  conflictZones?: string[];
}

export interface LlmApprovalContinuation {
  kind: 'llm-chat';
  tabId: string;
  model: string;
  provider: 'openai' | 'anthropic' | 'google';
  messages: Array<{ role: string; content: string }>;
  approvedTools: string[];
  repoPath?: string;
}

export interface RuntimeApprovalContinuation {
  kind: 'runtime';
  runtimeId: string;
  sessionKey: string;
  /** What to do after approval: 'resume' sends a follow-up, 'launch' starts a new session */
  action: 'resume' | 'launch';
  /** Original prompt (for launch actions) */
  prompt?: string;
  /** Follow-up message (for resume actions) */
  message?: string;
  /** Working directory */
  cwd?: string;
}

export interface LaneApprovalContinuation {
  kind: 'lane';
  laneId: string;
  verb: 'resume' | 'merge' | 'create_pr';
  commitMessage?: string;
}

export interface PlanApprovalContinuation {
  kind: 'plan';
  repoPath: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  tasks: Array<{ title: string; body: string }>;
  runtime: 'codex' | 'claude-code';
  constraints?: string;
}

export type ApprovalContinuation = LlmApprovalContinuation | RuntimeApprovalContinuation | LaneApprovalContinuation | PlanApprovalContinuation;

export interface ApprovalRecord {
  id: string;
  source: ApprovalSource;
  runtime: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  summary: string;
  toolName?: string;
  args?: Record<string, unknown>;
  command?: string;
  editable?: boolean;
  diff?: ApprovalDiffPreview;
  risk: ApprovalRisk;
  metadata?: Record<string, string>;
  /** Policy rule that triggered this approval */
  policyRuleId?: string;
  status: ApprovalStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolution?: {
    action: Exclude<ApprovalStatus, 'pending'>;
    actor: ApprovalActor;
    note?: string;
  };
  audit: ApprovalAuditEvent[];
  fingerprint: string;
  continuation?: ApprovalContinuation;
}

export interface CreateApprovalInput {
  source: ApprovalSource;
  runtime: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  summary: string;
  toolName?: string;
  args?: Record<string, unknown>;
  command?: string;
  editable?: boolean;
  diff?: ApprovalDiffPreview;
  risk: ApprovalRisk;
  metadata?: Record<string, string>;
  /** Policy rule that triggered this approval (from evaluatePolicy) */
  policyRuleId?: string;
  continuation?: ApprovalContinuation;
}

export interface MobileApprovalCard {
  id: string;
  sessionKey: string;
  agent: string;
  severity: EventSeverity;
  title: string;
  description: string;
  metadata?: Record<string, string>;
  actions: {
    approve: { label: string };
    reject: { label: string };
  };
  createdAt: number;
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord;
  assistantMessage?: {
    id: string;
    role: 'assistant';
    content: string;
    timestamp: number;
    model?: string;
    toolCalls?: MobileTranscriptToolCall[];
    sources?: MobileTranscriptSource[];
    thinking?: string;
  };
  nextApproval?: ApprovalRecord;
  note: string;
}
