// o8 governance policy engine — v0.002.0
/**
 * Policy engine for o8 governance layer.
 *
 * Evaluates tool calls and agent actions against policy rules to determine
 * whether human approval is required and at what risk level.
 *
 * v0.002.0: file-backed user overrides with workspace scoping and hot reload.
 */

import os from 'node:os';
import path from 'node:path';
import { loadUserPolicies, mergePolicies, watchPolicies } from '@/lib/approvals/policy-loader';
import type { ApprovalRisk, PolicyRule, PolicyRuleOverride } from '@/lib/approvals/types';
import { classifyCommand } from '@/lib/llm/tools';
import type { RequireApproval } from '@/lib/operator/defaults';

// ── Types ──

/**
 * Context about an action being evaluated.
 * Works for LLM tool calls, runtime adapter actions, and orchestrator delegations.
 */
export interface PolicyContext {
  /** Tool or action name (e.g. 'run_terminal_command', 'write_file', 'Bash', 'delegate_task') */
  toolName: string;
  /** Tool arguments */
  args?: Record<string, unknown>;
  /** Shell command string (convenience — also checked in args.command) */
  command?: string;
  /** File path (convenience — also checked in args.path) */
  filePath?: string;
  /** Repo or workspace path used for workspace-scoped rules */
  workspacePath?: string;
  /** Runtime originating the action */
  runtime?: string;
  /** Session key for audit context */
  sessionKey?: string;
  /** Resolved operator posture for lane merge approvals. */
  requireApproval?: RequireApproval;
}

/**
 * Result of evaluating an action against policies.
 */
export interface PolicyEvaluation {
  /** Whether human approval is required */
  requiresApproval: boolean;
  /** Risk level for the approval UI (determines badge color, sort order) */
  risk: ApprovalRisk;
  /** Human-readable reason for the decision */
  reason: string;
  /** Which policy rule triggered (for audit trail) */
  ruleId: string;
  /** If true, the action is completely blocked — not just approval-gated */
  blocked?: boolean;
}

interface CompiledPolicyRule extends PolicyRule {
  /** Predicate: does this rule apply to the given context? */
  matches: (ctx: PolicyContext) => boolean;
}

type PolicyRuleWithWorkspace = Pick<PolicyRuleOverride, 'workspacePath'>;

// ── Shell tool detection ──

const SHELL_TOOL_NAMES = new Set([
  'run_terminal_command',  // o8 LLM chat
  'Bash',                  // Claude Code
  'shell',                 // Codex
  'execute_command',       // Generic
]);

function isShellTool(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName);
}

function extractCommand(ctx: PolicyContext): string {
  return ctx.command
    || (ctx.args?.command as string)
    || (ctx.args?.cmd as string)
    || '';
}

// ── Destructive and migration patterns ──

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(?!.*--dry-run).*\//,              // rm with path (not dry-run)
  /\bgit\s+push\s+(--force|-f)\b/,           // git force push
  /\bgit\s+reset\s+--hard/,                  // git reset --hard
  /\bgit\s+clean\s+-[fd]/,                   // git clean -f/-d
  /\bgit\s+checkout\s+\.\s*$/,               // git checkout . (discard all changes)
  /\bdrop\s+(table|database|schema)\b/i,     // DROP TABLE/DATABASE/SCHEMA
  /\btruncate\s+table\b/i,                   // TRUNCATE TABLE
  /\bdelete\s+from\b(?!.*\bwhere\b)/i,       // DELETE FROM without WHERE
];

const MIGRATION_PATTERNS: RegExp[] = [
  /\bmigrat(e|ion)\b/i,                      // migrate, migration
  /\bknex\s+migrate/,                        // Knex
  /\bprisma\s+(migrate|db\s+push)/,          // Prisma
  /\bdrizzle-kit\s+(push|generate)/,         // Drizzle
  /\balembic\b/,                             // Python Alembic
  /\bdjango.*\bmigrate\b/,                   // Django
  /\brails\s+db:migrate/,                    // Rails
  /\btypeorm.*migration:run/,                // TypeORM
  /\bsequelize.*db:migrate/,                 // Sequelize
];

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env(?:\.|$)/,                           // .env, .env.local, .env.production
  /credentials/i,                            // credentials.json, etc.
  /\.pem$/,                                  // SSL certificates
  /\.key$/,                                  // Private keys
  /secrets?\.ya?ml$/i,                       // secrets.yml
  /\.ssh\//,                                 // SSH directory
  /id_rsa/,                                  // SSH keys
];

// ── Policy rules (ordered by severity — first match wins) ──

const DEFAULT_RULES: CompiledPolicyRule[] = [

  // ────────────────────────────────────────────────
  // BLOCKED — action is rejected entirely, not gated
  // ────────────────────────────────────────────────

  {
    id: 'blocked-shell',
    name: 'Blocked shell command',
    description: 'Dangerous command that should never execute from the control plane (rm -rf, sudo, eval, etc.)',
    risk: 'high',
    blocked: true,
    matches: (ctx) => {
      if (!isShellTool(ctx.toolName)) return false;
      const cmd = extractCommand(ctx);
      if (!cmd) return false;
      return classifyCommand(cmd).safety === 'blocked';
    },
  },

  // ────────────────────────────────
  // HIGH RISK — always require human
  // ────────────────────────────────

  {
    id: 'file-deletion',
    name: 'File deletion',
    description: 'Deleting a file from the workspace requires explicit approval',
    risk: 'high',
    matches: (ctx) => ctx.toolName === 'delete_file',
  },

  {
    id: 'destructive-shell',
    name: 'Destructive shell command',
    description: 'Shell command that deletes data, force-pushes, or resets git state',
    risk: 'high',
    matches: (ctx) => {
      if (!isShellTool(ctx.toolName)) return false;
      const cmd = extractCommand(ctx);
      if (!cmd) return false;
      return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(cmd));
    },
  },

  {
    id: 'database-migration',
    name: 'Database migration',
    description: 'Database migration that could alter schema or destroy data',
    risk: 'high',
    matches: (ctx) => {
      if (!isShellTool(ctx.toolName)) return false;
      const cmd = extractCommand(ctx);
      if (!cmd) return false;
      return MIGRATION_PATTERNS.some((pattern) => pattern.test(cmd));
    },
  },

  {
    id: 'pr-creation',
    name: 'Pull request creation',
    description: 'Creating a pull request visible to the team',
    risk: 'high',
    matches: (ctx) => ctx.toolName === 'create_pull_request',
  },

  {
    id: 'file_size_limit',
    name: 'File size limit',
    description: 'Merging changes to a non-waived file above the file size governance threshold requires operator approval.',
    risk: 'high',
    enabled: true,
    matches: (ctx) => {
      if (ctx.toolName !== 'lane_command') return false;
      const verb = ctx.args?.verb as string | undefined;
      return verb === 'merge' && ctx.args?.fileSizeLimitExceeded === true;
    },
  },

  {
    id: 'auto_approve_lane_merge',
    name: 'Full-autonomy lane merge',
    description: 'Allow normal lane merge or PR actions when the operator explicitly selected full autonomy.',
    risk: 'low',
    enabled: true,
    requiresApproval: false,
    matches: (ctx) => {
      if (ctx.toolName !== 'lane_command' || ctx.requireApproval !== 'never') return false;
      const verb = ctx.args?.verb as string | undefined;
      return verb === 'merge' || verb === 'create_pr';
    },
  },

  {
    id: 'auto_approve_orchestrator_review',
    name: 'Auto-approve orchestrator review',
    description: 'Allow merge or PR actions that come from an active orchestrator auto-review pass.',
    risk: 'low',
    enabled: true,
    requiresApproval: false,
    matches: (ctx) => {
      if (ctx.toolName !== 'lane_command' || ctx.requireApproval === 'always') return false;
      const verb = ctx.args?.verb as string | undefined;
      return (verb === 'merge' || verb === 'create_pr') && ctx.args?.autoReview === true;
    },
  },

  {
    id: 'lane-merge',
    name: 'Lane merge or PR',
    description: 'Merging a lane worktree or creating a PR from agent work',
    risk: 'high',
    matches: (ctx) => {
      if (ctx.toolName !== 'lane_command') return false;
      const verb = ctx.args?.verb as string;
      return verb === 'merge' || verb === 'create_pr';
    },
  },

  // ──────────────────────────────────
  // MEDIUM RISK — require human review
  // ──────────────────────────────────

  {
    id: 'sensitive-file-write',
    name: 'Sensitive file modification',
    description: 'Writing to a sensitive file (.env, credentials, keys)',
    risk: 'medium',
    matches: (ctx) => {
      if (ctx.toolName !== 'write_file' && ctx.toolName !== 'edit_file') return false;
      const filePath = ctx.filePath || (ctx.args?.path as string) || '';
      return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
    },
  },

  {
    id: 'file-write',
    name: 'File write',
    description: 'Creating or overwriting a workspace file',
    risk: 'medium',
    matches: (ctx) => ctx.toolName === 'write_file',
  },

  {
    id: 'file-edit',
    name: 'File edit',
    description: 'Modifying an existing workspace file',
    risk: 'medium',
    matches: (ctx) => ctx.toolName === 'edit_file',
  },

  {
    id: 'github-issue',
    name: 'GitHub issue creation',
    description: 'Creating a GitHub issue visible to collaborators',
    risk: 'medium',
    matches: (ctx) => ctx.toolName === 'create_github_issue',
  },

  {
    id: 'lane-open',
    name: 'Lane creation',
    description: 'Opening a new work lane with an isolated worktree',
    risk: 'medium',
    matches: (ctx) => {
      if (ctx.toolName !== 'lane_command') return false;
      return ctx.args?.verb === 'open_lane';
    },
  },

  {
    id: 'mutation-shell',
    name: 'Mutation shell command',
    description: 'Shell command that modifies state (installs packages, commits code, etc.)',
    risk: 'medium',
    matches: (ctx) => {
      if (!isShellTool(ctx.toolName)) return false;
      const cmd = extractCommand(ctx);
      if (!cmd) return false;
      return classifyCommand(cmd).safety === 'needs_approval';
    },
  },

  {
    id: 'auto_approve_low_risk',
    name: 'Auto-approve low-risk action',
    description: 'Allow low-risk actions when no higher-priority policy matched.',
    risk: 'low',
    enabled: true,
    requiresApproval: false,
    matches: () => true,
  },
];

const DEFAULT_RULES_BY_ID = new Map(DEFAULT_RULES.map((rule) => [rule.id, rule]));

let mergedRuleSummaries = clonePolicyRules(serializeRules(DEFAULT_RULES));
let activeRules = [...DEFAULT_RULES];
let scopedOverridesById = new Map<string, PolicyRuleOverride[]>();
let policyRulesLoaded = false;
let policyWatcherAttached = false;

function serializeRules(rules: CompiledPolicyRule[]): PolicyRule[] {
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    risk: rule.risk,
    blocked: rule.blocked,
    workspacePath: rule.workspacePath,
    enabled: rule.enabled,
    requiresApproval: rule.requiresApproval,
  }));
}

function clonePolicyRules(rules: PolicyRule[]): PolicyRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function normalizeWorkspacePath(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed.replace(/^~(?=\/|$)/, os.homedir())).replace(/\/+$/, '');
}

function extractWorkspacePath(ctx: PolicyContext): string {
  const argWorkspacePath = typeof ctx.args?.workspacePath === 'string'
    ? ctx.args.workspacePath
    : typeof ctx.args?.repoPath === 'string'
      ? ctx.args.repoPath
      : typeof ctx.args?.cwd === 'string'
        ? ctx.args.cwd
        : undefined;

  return normalizeWorkspacePath(ctx.workspacePath ?? argWorkspacePath);
}

function matchesWorkspacePath(rule: PolicyRuleWithWorkspace, ctx: PolicyContext): boolean {
  const requiredPath = normalizeWorkspacePath(rule.workspacePath);
  if (!requiredPath) {
    return true;
  }

  const candidatePath = extractWorkspacePath(ctx);
  if (!candidatePath) {
    return false;
  }

  return candidatePath === requiredPath || candidatePath.startsWith(`${requiredPath}/`);
}

function getMatchingScopedOverride(ruleId: string, ctx: PolicyContext): PolicyRuleOverride | undefined {
  const scopedOverrides = scopedOverridesById.get(ruleId);
  if (!scopedOverrides) {
    return undefined;
  }

  for (let index = scopedOverrides.length - 1; index >= 0; index -= 1) {
    const override = scopedOverrides[index];
    if (matchesWorkspacePath(override, ctx)) {
      return override;
    }
  }

  return undefined;
}

function rebuildPolicyState(overrides: PolicyRuleOverride[]) {
  const globalOverrides = overrides.filter((rule) => !normalizeWorkspacePath(rule.workspacePath));
  const scopedOverrides = overrides.filter((rule) => normalizeWorkspacePath(rule.workspacePath));
  const defaultSummaries = serializeRules(DEFAULT_RULES);
  mergedRuleSummaries = mergePolicies(defaultSummaries, globalOverrides);
  activeRules = mergedRuleSummaries.flatMap((rule) => {
    const defaultRule = DEFAULT_RULES_BY_ID.get(rule.id);
    if (!defaultRule) {
      return [];
    }

    const mergedRule = { ...defaultRule, ...rule };
    return mergedRule.enabled === false ? [] : [mergedRule];
  });
  scopedOverridesById = scopedOverrides.reduce((map, override) => {
    if (!DEFAULT_RULES_BY_ID.has(override.id)) {
      return map;
    }

    const scopedRules = map.get(override.id) ?? [];
    scopedRules.push({ ...override, workspacePath: normalizeWorkspacePath(override.workspacePath) });
    map.set(override.id, scopedRules);
    return map;
  }, new Map<string, PolicyRuleOverride[]>());
  policyRulesLoaded = true;
}

function ensurePolicyWatcher() {
  if (policyWatcherAttached) {
    return;
  }

  watchPolicies((rules) => {
    rebuildPolicyState(rules);
  });
  policyWatcherAttached = true;
}

function ensurePolicyState() {
  if (!policyRulesLoaded) {
    rebuildPolicyState(loadUserPolicies());
  }
  ensurePolicyWatcher();
}

export function getDefaultPolicyRules(): PolicyRule[] {
  return clonePolicyRules(serializeRules(DEFAULT_RULES));
}

export function refreshPolicyRules(): PolicyRule[] {
  rebuildPolicyState(loadUserPolicies());
  ensurePolicyWatcher();
  return clonePolicyRules(mergedRuleSummaries);
}

// ── Public API ──

/**
 * Evaluate an action against all policy rules.
 * Returns the first matching rule's evaluation.
 */
export function evaluatePolicy(ctx: PolicyContext): PolicyEvaluation {
  ensurePolicyState();

  for (const activeRule of activeRules) {
    const scopedOverride = getMatchingScopedOverride(activeRule.id, ctx);
    if (scopedOverride?.enabled === false) {
      continue;
    }

    const rule = scopedOverride ? { ...activeRule, ...scopedOverride } : activeRule;
    if (!matchesWorkspacePath(rule, ctx)) {
      continue;
    }
    if (rule.matches(ctx)) {
      const requiresApproval = rule.blocked ? true : rule.requiresApproval ?? true;
      return {
        requiresApproval,
        risk: rule.risk,
        reason: rule.description,
        ruleId: rule.id,
        blocked: rule.blocked,
      };
    }
  }

  return {
    requiresApproval: true,
    risk: 'low',
    reason: 'Low-risk auto-approval is disabled for this workspace',
    ruleId: 'auto_approve_low_risk',
  };
}

/**
 * List all policy rules for API/UI serialization.
 */
export function listPolicySummaries(): PolicyRule[] {
  ensurePolicyState();
  return clonePolicyRules(mergedRuleSummaries);
}

/**
 * Get a specific policy rule by ID.
 */
export function getPolicyRule(ruleId: string): PolicyRule | undefined {
  ensurePolicyState();
  const rule = mergedRuleSummaries.find((candidate) => candidate.id === ruleId);
  return rule ? { ...rule } : undefined;
}

/**
 * Convenience: build a PolicyContext from a tool call name + args.
 * Extracts common fields (command, filePath, workspacePath) from args automatically.
 */
export function buildPolicyContext(
  toolName: string,
  args?: Record<string, unknown>,
  extra?: Partial<PolicyContext>,
): PolicyContext {
  const workspacePath = typeof args?.workspacePath === 'string'
    ? args.workspacePath
    : typeof args?.repoPath === 'string'
      ? args.repoPath
      : typeof args?.cwd === 'string'
        ? args.cwd
        : undefined;

  return {
    toolName,
    args,
    command: (args?.command as string) || (args?.cmd as string) || undefined,
    filePath: (args?.path as string) || (args?.filePath as string) || undefined,
    workspacePath,
    ...extra,
  };
}
