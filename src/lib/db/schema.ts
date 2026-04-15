/**
 * Database Schema — Foundation for Monetization
 *
 * SQLite for local/dev, designed to map cleanly to PostgreSQL for production.
 * All monetization features (auth, billing, usage, teams) depend on these tables.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/217
 */

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ══════════════════════════════════════════════════════════════════
//  Users — core identity
// ══════════════════════════════════════════════════════════════════

export const users = sqliteTable('users', {
  /** UUID primary key */
  id: text('id').primaryKey(),
  /** GitHub user ID (unique, nullable for email-only users) */
  githubId: integer('github_id').unique(),
  /** Discord user ID (unique, nullable) */
  discordId: text('discord_id').unique(),
  /** Email address */
  email: text('email').unique(),
  /** Display name */
  name: text('name'),
  /** Avatar URL (from GitHub/Discord) */
  avatarUrl: text('avatar_url'),
  /** Plan tier: free | pro | team */
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
  /** Monthly token budget in USD (null = unlimited for BYOK) */
  tokenBudgetUsd: real('token_budget_usd'),
  /** Created timestamp (ISO 8601) */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /** Last updated timestamp */
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  /** Last login timestamp */
  lastLoginAt: text('last_login_at'),
});

// ══════════════════════════════════════════════════════════════════
//  API Keys — BYOK storage (encrypted at rest)
// ══════════════════════════════════════════════════════════════════

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** LLM provider: anthropic | openai | google */
  provider: text('provider', { enum: ['anthropic', 'openai', 'google'] }).notNull(),
  /** Encrypted API key (AES-256-GCM, key from env) */
  encryptedKey: text('encrypted_key').notNull(),
  /** IV for decryption */
  iv: text('iv').notNull(),
  /** Label (user-friendly name, e.g. "Work key") */
  label: text('label'),
  /** Is this the active key for this provider? */
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Usage Logs — token metering per request
// ══════════════════════════════════════════════════════════════════

export const usageLogs = sqliteTable('usage_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Model used (e.g. claude-opus-4-6, gpt-5.4) */
  model: text('model').notNull(),
  /** LLM provider */
  provider: text('provider', { enum: ['anthropic', 'openai', 'google'] }).notNull(),
  /** Input tokens consumed */
  inputTokens: integer('input_tokens').notNull().default(0),
  /** Output tokens consumed */
  outputTokens: integer('output_tokens').notNull().default(0),
  /** Cache read tokens (Anthropic) */
  cacheReadTokens: integer('cache_read_tokens').default(0),
  /** Cache write tokens (Anthropic) */
  cacheWriteTokens: integer('cache_write_tokens').default(0),
  /** Computed cost in USD */
  costUsd: real('cost_usd').notNull().default(0),
  /** Associated agent session key */
  sessionKey: text('session_key'),
  /** Repository where the session ran */
  repoPath: text('repo_path'),
  /** Agent name (for breakdown) */
  agentName: text('agent_name'),
  /** Request type: chat | completion | embedding */
  requestType: text('request_type', { enum: ['chat', 'completion', 'embedding'] }).default('chat'),
  /** Billing period (YYYY-MM for monthly rollups) */
  billingPeriod: text('billing_period').notNull(),
  /** Timestamp */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Subscriptions — Stripe billing link
// ══════════════════════════════════════════════════════════════════

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  /** Stripe customer ID */
  stripeCustomerId: text('stripe_customer_id').unique(),
  /** Stripe subscription ID */
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  /** Plan at Stripe level */
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
  /** Subscription status */
  status: text('status', { enum: ['active', 'canceled', 'past_due', 'trialing', 'incomplete'] }).notNull().default('active'),
  /** Current period end (ISO 8601) */
  currentPeriodEnd: text('current_period_end'),
  /** Whether subscription auto-cancels at period end */
  cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Sessions — auth sessions (JWT tracking)
// ══════════════════════════════════════════════════════════════════

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Hashed refresh token */
  tokenHash: text('token_hash').notNull(),
  /** User agent string */
  userAgent: text('user_agent'),
  /** IP address */
  ipAddress: text('ip_address'),
  /** Expires at (ISO 8601) */
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Teams — multi-user organizations
// ══════════════════════════════════════════════════════════════════

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Owner user ID */
  ownerId: text('owner_id').notNull().references(() => users.id),
  /** Slug for URL (team identifier) */
  slug: text('slug').unique(),
  /** Pooled token budget in USD per month */
  tokenBudgetUsd: real('token_budget_usd'),
  /** Max seats */
  maxSeats: integer('max_seats').default(10),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const teamMembers = sqliteTable('team_members', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Member role */
  role: text('role', { enum: ['owner', 'admin', 'member', 'readonly'] }).notNull().default('member'),
  joinedAt: text('joined_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Waitlist — pre-launch signups
// ══════════════════════════════════════════════════════════════════

export const waitlist = sqliteTable('waitlist', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  githubUsername: text('github_username'),
  source: text('source'), // where they heard about us
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  GitHub Broker — durable remote snapshots for local and prod
// ══════════════════════════════════════════════════════════════════

export const githubInstallations = sqliteTable('github_installations', {
  installationId: integer('installation_id').primaryKey(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type'),
  targetType: text('target_type'),
  permissionsJson: text('permissions_json'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const githubRepositories = sqliteTable('github_repositories', {
  repoId: integer('repo_id').primaryKey(),
  fullName: text('full_name').notNull().unique(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  private: integer('private', { mode: 'boolean' }).notNull().default(false),
  defaultBranch: text('default_branch'),
  installationId: integer('installation_id').references(() => githubInstallations.installationId, { onDelete: 'set null' }),
  lastWebhookAt: text('last_webhook_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const githubSyncState = sqliteTable('github_sync_state', {
  key: text('key').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  resource: text('resource').notNull(),
  etag: text('etag'),
  lastSyncedAt: text('last_synced_at'),
  lastSuccessfulAt: text('last_successful_at'),
  lastError: text('last_error'),
  staleAt: text('stale_at'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const githubIssues = sqliteTable('github_issues', {
  issueId: integer('issue_id').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  authorLogin: text('author_login'),
  body: text('body'),
  labelsJson: text('labels_json').notNull().default('[]'),
  assigneesJson: text('assignees_json').notNull().default('[]'),
  commentsCount: integer('comments_count').notNull().default(0),
  url: text('url').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  closedAt: text('closed_at'),
});

export const githubPullRequests = sqliteTable('github_pull_requests', {
  pullRequestId: integer('pull_request_id').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  state: text('state').notNull(),
  authorLogin: text('author_login'),
  body: text('body'),
  headRefName: text('head_ref_name'),
  baseRefName: text('base_ref_name'),
  additions: integer('additions').notNull().default(0),
  deletions: integer('deletions').notNull().default(0),
  changedFiles: integer('changed_files').notNull().default(0),
  reviewDecision: text('review_decision'),
  statusChecksJson: text('status_checks_json').notNull().default('[]'),
  url: text('url').notNull(),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  closedAt: text('closed_at'),
  mergedAt: text('merged_at'),
});

// ══════════════════════════════════════════════════════════════════
//  Approvals — durable approval and audit history
// ══════════════════════════════════════════════════════════════════

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  source: text('source', { enum: ['llm-chat', 'runtime', 'test'] }).notNull(),
  runtime: text('runtime').notNull(),
  agent: text('agent').notNull(),
  sessionKey: text('session_key').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  summary: text('summary').notNull(),
  toolName: text('tool_name'),
  argsJson: text('args_json'),
  command: text('command'),
  editable: integer('editable', { mode: 'boolean' }),
  diffJson: text('diff_json'),
  gateResultJson: text('gate_result_json'),
  conflictReportJson: text('conflict_report_json'),
  risk: text('risk', { enum: ['low', 'medium', 'high'] }).notNull(),
  metadataJson: text('metadata_json'),
  packetId: text('packet_id'),
  laneId: text('lane_id'),
  policyRuleId: text('policy_rule_id'),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  resolvedAt: integer('resolved_at'),
  resolutionJson: text('resolution_json'),
  auditJson: text('audit_json').notNull().default('[]'),
  fingerprint: text('fingerprint').notNull(),
  continuationJson: text('continuation_json'),
}, (table) => ({
  statusCreatedIdx: index('idx_approvals_status_created').on(table.status, table.createdAt),
  sessionKeyCreatedIdx: index('idx_approvals_session_key_created').on(table.sessionKey, table.createdAt),
  packetIdIdx: index('idx_approvals_packet_id').on(table.packetId),
  laneIdIdx: index('idx_approvals_lane_id').on(table.laneId),
  fingerprintStatusIdx: index('idx_approvals_fingerprint_status').on(table.fingerprint, table.status),
  resolvedAtIdx: index('idx_approvals_resolved_at').on(table.resolvedAt),
}));

// ══════════════════════════════════════════════════════════════════
//  Lane Registry — durable multi-process orchestration state
// ══════════════════════════════════════════════════════════════════

export const lanes = sqliteTable('lanes', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  repoPath: text('repo_path').notNull(),
  worktreePath: text('worktree_path'),
  branch: text('branch').notNull(),
  baseBranch: text('base_branch').notNull(),
  runtime: text('runtime', { enum: ['codex', 'claude-code'] }).notNull(),
  sessionKey: text('session_key'),
  packetId: text('packet_id'),
  status: text('status', {
    enum: ['idle', 'launching', 'running', 'paused', 'awaiting_input', 'reviewing', 'merging', 'completed', 'archived'],
  }).notNull(),
  ownership: text('ownership', { enum: ['managed', 'attached'] }).notNull(),
  writerToken: text('writer_token'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastEventAt: text('last_event_at'),
  lastEventLabel: text('last_event_label'),
}, (table) => ({
  sessionKeyIdx: index('idx_lanes_session_key').on(table.sessionKey),
  packetIdIdx: index('idx_lanes_packet_id').on(table.packetId),
  repoBranchStatusIdx: index('idx_lanes_repo_branch_status').on(table.repoPath, table.branch, table.status),
  statusIdx: index('idx_lanes_status').on(table.status),
}));

// ══════════════════════════════════════════════════════════════════
//  External MCP Servers — user-configured orchestrator context sources
// ══════════════════════════════════════════════════════════════════

export const externalMcpServers = sqliteTable('external_mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command').notNull(),
  args: text('args').notNull().default('[]'),
  envJson: text('env_json'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  enabledIdx: index('idx_external_mcp_servers_enabled').on(table.enabled),
  updatedAtIdx: index('idx_external_mcp_servers_updated_at').on(table.updatedAt),
}));

export const approvalEvents = sqliteTable('approval_events', {
  id: text('id').primaryKey(),
  approvalId: text('approval_id').notNull(),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull(),
  note: text('note'),
  detailsJson: text('details_json').notNull().default('{}'),
  timestamp: integer('timestamp').notNull(),
}, (table) => ({
  approvalTimestampIdx: index('idx_approval_events_approval_timestamp').on(table.approvalId, table.timestamp),
}));

// ══════════════════════════════════════════════════════════════════
//  Review Queue — durable auto-review queue (survives restarts)
// ══════════════════════════════════════════════════════════════════

export const reviewQueue = sqliteTable('review_queue', {
  id: text('id').primaryKey(),
  laneId: text('lane_id').notNull(),
  repoPath: text('repo_path').notNull(),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  statusIdx: index('idx_review_queue_status').on(table.status),
  laneIdIdx: index('idx_review_queue_lane_id').on(table.laneId),
}));

// ══════════════════════════════════════════════════════════════════
//  Watched Agents — durable supervisor state (survives restarts)
// ══════════════════════════════════════════════════════════════════

export const watchedAgents = sqliteTable('watched_agents', {
  surfaceId: text('surface_id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  name: text('name').notNull(),
  prompt: text('prompt').notNull().default(''),
  registeredAt: integer('registered_at').notNull(),
  lastStatus: text('last_status').notNull().default('running'),
  retryCount: integer('retry_count').notNull().default(0),
  steerCount: integer('steer_count').notNull().default(0),
  completionReported: integer('completion_reported', { mode: 'boolean' }).notNull().default(false),
  lastEventAt: integer('last_event_at').notNull().default(0),
  lastActivityAt: integer('last_activity_at').notNull(),
});

export const laneEvents = sqliteTable('lane_events', {
  id: text('id').primaryKey(),
  laneId: text('lane_id').notNull().references(() => lanes.id, { onDelete: 'cascade' }),
  verb: text('verb').notNull(),
  actor: text('actor', { enum: ['user', 'orchestrator', 'system'] }).notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  timestamp: text('timestamp').notNull(),
}, (table) => ({
  laneTimestampIdx: index('idx_lane_events_lane_timestamp').on(table.laneId, table.timestamp),
  timestampIdx: index('idx_lane_events_timestamp').on(table.timestamp),
}));
