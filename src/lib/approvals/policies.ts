/**
 * Policy engine for o8 governance layer.
 *
 * Evaluates tool calls and agent actions against policy rules to determine
 * whether human approval is required and at what risk level.
 *
 * v0.001.0: Hardcoded rules, first-match-wins evaluation.
 * Future: per-workspace configurable policies, team override rules.
 */

import type { ApprovalRisk } from './types';
import { classifyCommand } from '@/lib/llm/tools';

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
  /** Runtime originating the action */
  runtime?: string;
  /** Session key for audit context */
  sessionKey?: string;
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

/**
 * A single policy rule. Evaluated in order — first match wins.
 */
export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  risk: ApprovalRisk;
  /** If true, matching actions are blocked entirely */
  blocked?: boolean;
  /** Predicate: does this rule apply to the given context? */
  matches: (ctx: PolicyContext) => boolean;
}

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
  /\bdrop\s+(table|database|schema)\b/i,      // DROP TABLE/DATABASE/SCHEMA
  /\btruncate\s+table\b/i,                   // TRUNCATE TABLE
  /\bdelete\s+from\b(?!.*\bwhere\b)/i,       // DELETE FROM without WHERE
];

const MIGRATION_PATTERNS: RegExp[] = [
  /\bmigrat(e|ion)\b/i,                      // migrate, migration
  /\bknex\s+migrate/,                         // Knex
  /\bprisma\s+(migrate|db\s+push)/,           // Prisma
  /\bdrizzle-kit\s+(push|generate)/,          // Drizzle
  /\balembic\b/,                              // Python Alembic
  /\bdjango.*\bmigrate\b/,                    // Django
  /\brails\s+db:migrate/,                     // Rails
  /\btypeorm.*migration:run/,                 // TypeORM
  /\bsequelize.*db:migrate/,                  // Sequelize
];

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env(?:\.|$)/,                            // .env, .env.local, .env.production
  /credentials/i,                             // credentials.json, etc.
  /\.pem$/,                                   // SSL certificates
  /\.key$/,                                   // Private keys
  /secrets?\.ya?ml$/i,                        // secrets.yml
  /\.ssh\//,                                  // SSH directory
  /id_rsa/,                                   // SSH keys
];

// ── Policy rules (ordered by severity — first match wins) ──

const RULES: PolicyRule[] = [

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
      return DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd));
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
      return MIGRATION_PATTERNS.some((p) => p.test(cmd));
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
      const path = ctx.filePath || (ctx.args?.path as string) || '';
      return SENSITIVE_FILE_PATTERNS.some((p) => p.test(path));
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
];

// ── Public API ──

/**
 * Evaluate an action against all policy rules.
 * Returns the first matching rule's evaluation, or auto-approve if no rules match.
 */
export function evaluatePolicy(ctx: PolicyContext): PolicyEvaluation {
  for (const rule of RULES) {
    if (rule.matches(ctx)) {
      return {
        requiresApproval: true,
        risk: rule.risk,
        reason: rule.description,
        ruleId: rule.id,
        blocked: rule.blocked,
      };
    }
  }

  return {
    requiresApproval: false,
    risk: 'low',
    reason: 'No policy rule triggered',
    ruleId: 'default-allow',
  };
}

/**
 * List all policy rules (without match functions, for API/UI serialization).
 */
export function listPolicySummaries(): Array<Omit<PolicyRule, 'matches'>> {
  return RULES.map(({ matches: _matches, ...rest }) => rest);
}

/**
 * Get a specific policy rule by ID.
 */
export function getPolicyRule(ruleId: string): PolicyRule | undefined {
  return RULES.find((r) => r.id === ruleId);
}

/**
 * Convenience: build a PolicyContext from a tool call name + args.
 * Extracts common fields (command, filePath) from args automatically.
 */
export function buildPolicyContext(
  toolName: string,
  args?: Record<string, unknown>,
  extra?: Partial<PolicyContext>,
): PolicyContext {
  return {
    toolName,
    args,
    command: (args?.command as string) || (args?.cmd as string) || undefined,
    filePath: (args?.path as string) || (args?.filePath as string) || undefined,
    ...extra,
  };
}
