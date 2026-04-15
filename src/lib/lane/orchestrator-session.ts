/**
 * Orchestrator session — runs Claude Code in non-interactive mode with
 * structured JSON output. Each message spawns a short-lived process:
 *
 *   claude -p "message" --output-format stream-json --dangerously-skip-permissions
 *
 * Conversation context persists via `--resume SESSION_ID` on follow-up
 * messages. This avoids all TUI/ANSI parsing issues.
 */

import { createHash } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import { getRuntime, type RuntimeSession } from '@/lib/runtimes';
import { getOrCreateWsToken } from '@/lib/ws-auth';

// ── Types ──

export interface OrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** Claude Code session ID for --resume continuity */
  claudeSessionId: string | null;
  status: 'ready' | 'busy' | 'dead';
  /** Currently-running child process (null when idle) */
  proc: ChildProcess | null;
  createdAt: number;
}

/** Structured events emitted from the JSON stream */
export type OrchestratorEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'done'; sessionId: string | null; cost: number | null }
  | { type: 'error'; error: string };

// ── Constants ──

const CLAUDE_BIN = process.env.CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');

/**
 * Resolve the Cortex MCP server entry point.
 *
 * In a packaged Tauri app the TS source isn't shipped — only the esbuild
 * output in `resource_dir/server/cortex-mcp-server.mjs`. The Rust sidecar
 * sets `O8_BUNDLED_MCP_DIR` to the resource/server directory before spawning
 * Next, so we prefer the bundled .mjs when it exists.
 *
 * Dev checkout falls back to the TS source run under `tsx`.
 */
function resolveCortexMcpServerPath(): { command: string; path: string } {
  const bundledDir = process.env.O8_BUNDLED_MCP_DIR;
  if (bundledDir) {
    const bundled = join(bundledDir, 'cortex-mcp-server.mjs');
    if (existsSync(bundled)) {
      // Prefer the node path the Tauri sidecar resolved via login shell
      // (handles nvm/fnm/volta that Finder's minimal PATH misses).
      const nodeBin = process.env.O8_NODE_BIN || 'node';
      return { command: nodeBin, path: bundled };
    }
  }
  const devSource = resolve(dirname(new URL(import.meta.url).pathname), '../mcp/cortex-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

const MCP_CONFIG_DIR = join(homedir(), '.o8', 'mcp');
const LOG_PREFIX = '[orchestrator-rehydrate]';
/** #457 — Kill the claude process if it doesn't finish within this window */
const PROCESS_TIMEOUT_MS = 90_000;

let startupRehydrationPromise: Promise<void> | null = null;
let startupRehydrationComplete = false;

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
}

function extractClaudeSessionId(sessionKey: string): string | null {
  return sessionKey.startsWith('claude-code:')
    ? sessionKey.slice('claude-code:'.length) || null
    : null;
}

function compareRehydrationCandidates(left: RuntimeSession, right: RuntimeSession) {
  const rank = (session: RuntimeSession) => {
    if (session.status === 'idle') return 0;
    if (session.status === 'reviewing') return 1;
    if (session.status === 'waiting') return 2;
    if (session.status === 'running') return 3;
    return 4;
  };

  const rankDelta = rank(left) - rank(right);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function buildRehydratedSession(repoPath: string, claudeSessionId: string, createdAt: number): OrchestratorSession {
  return {
    sessionName: orchestratorSessionName(repoPath),
    repoPath,
    claudeSessionId,
    status: 'ready',
    proc: null,
    createdAt,
  };
}

export async function rehydrateOrchestratorSessions(): Promise<void> {
  if (startupRehydrationComplete) {
    return;
  }
  if (startupRehydrationPromise) {
    return startupRehydrationPromise;
  }

  startupRehydrationPromise = (async () => {
    const activeLanes = listActiveLanesWithSessions();
    if (activeLanes.length === 0) {
      startupRehydrationComplete = true;
      return;
    }

    const runtimeIds = [...new Set(['claude-code', ...activeLanes.map((lane) => lane.runtime)])];
    const discoveredByRuntime = new Map<string, RuntimeSession[]>();

    for (const runtimeId of runtimeIds) {
      const runtime = getRuntime(runtimeId);
      if (!runtime?.capabilities.discover) {
        continue;
      }

      try {
        discoveredByRuntime.set(runtimeId, await runtime.discoverSessions());
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Failed to discover ${runtimeId} sessions during startup rehydration: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const liveLaneSessionKeys = new Set<string>();
    const reposNeedingRehydration = new Set<string>();

    for (const lane of activeLanes) {
      if (!lane.sessionKey) continue;
      const runtimeSessions = discoveredByRuntime.get(lane.runtime) ?? [];
      if (!runtimeSessions.some((session) => session.sessionKey === lane.sessionKey)) {
        continue;
      }

      liveLaneSessionKeys.add(lane.sessionKey);
      reposNeedingRehydration.add(normalizeRepoPath(lane.repoPath));
    }

    if (reposNeedingRehydration.size === 0) {
      startupRehydrationComplete = true;
      return;
    }

    const claudeSessions = (discoveredByRuntime.get('claude-code') ?? [])
      .filter((session) => session.status !== 'failed')
      .filter((session) => !liveLaneSessionKeys.has(session.sessionKey));

    let rehydratedCount = 0;

    for (const repoPath of reposNeedingRehydration) {
      const sessionName = orchestratorSessionName(repoPath);
      if (sessions.has(sessionName)) {
        continue;
      }

      const candidate = claudeSessions
        .filter((session) => normalizeRepoPath(session.cwd) === repoPath)
        .sort(compareRehydrationCandidates)[0];
      const claudeSessionId = candidate ? extractClaudeSessionId(candidate.sessionKey) : null;
      if (!candidate || !claudeSessionId) {
        continue;
      }

      sessions.set(
        sessionName,
        buildRehydratedSession(repoPath, claudeSessionId, candidate.lastActivityAt.getTime()),
      );
      rehydratedCount += 1;
      console.log(`${LOG_PREFIX} Rehydrated ${sessionName} from ${candidate.sessionKey}`);
    }

    console.log(
      `${LOG_PREFIX} Startup scan checked ${activeLanes.length} active lane${activeLanes.length === 1 ? '' : 's'} and restored ${rehydratedCount} orchestrator session${rehydratedCount === 1 ? '' : 's'}`,
    );
    startupRehydrationComplete = true;
  })()
    .finally(() => {
      startupRehydrationPromise = null;
    });

  return startupRehydrationPromise;
}

/** Resolve repo slug from git remote, cached per session. */
function detectRepoSlug(repoPath: string): string {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoPath, timeout: 3000, encoding: 'utf-8' }).trim();
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1] ?? '';
  } catch { return ''; }
}

/** Generate a temporary MCP config file pointing to the Cortex MCP server. */
function ensureMcpConfig(repoPath: string): string {
  if (!existsSync(MCP_CONFIG_DIR)) mkdirSync(MCP_CONFIG_DIR, { recursive: true });

  const configPath = join(MCP_CONFIG_DIR, `orchestrator-${repoHash(repoPath)}.json`);
  const repoSlug = detectRepoSlug(repoPath);
  // Use the shared port resolver so MCP children agree with the live backend
  // (which may be on 3001 in dev but 3002+ in a packaged install with a port
  // collision — see src/lib/panel/api-port.ts).
  const { getApiBase } = require('@/lib/panel/api-port') as typeof import('@/lib/panel/api-port');
  const apiBase = getApiBase();

  // Dev: `npx tsx <ts source>`. Packaged app: `node <bundled .mjs>`.
  const mcpServer = resolveCortexMcpServerPath();
  const args = mcpServer.command === 'npx'
    ? ['tsx', mcpServer.path]
    : [mcpServer.path];

  const config = {
    mcpServers: {
      cortex: {
        command: mcpServer.command,
        args,
        env: {
          CORTEX_API_BASE: apiBase,
          CORTEX_REPO_PATH: repoPath,
          CORTEX_REPO_SLUG: repoSlug,
          WS_PORT: String(process.env.WS_PORT || '3002'),
          WS_TOKEN: getOrCreateWsToken(),
        },
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[orchestrator-session] MCP config written to ${configPath}`);
  return configPath;
}

/** Appended to Claude Code's default system prompt on the first message only. */
function buildOrchestratorSystemPrompt(repoPath: string): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  // Load all registered repos for fleet awareness
  let allRepos: Array<{ name: string; localPath: string }> = [];
  try {
    const reposFile = join(homedir(), '.o8', 'repos.json');
    if (existsSync(reposFile)) {
      const { readFileSync } = require('node:fs');
      const parsed = JSON.parse(readFileSync(reposFile, 'utf-8'));
      allRepos = (parsed.repos ?? []).map((r: { name?: string; localPath: string }) => ({
        name: r.name ?? r.localPath.split('/').filter(Boolean).pop() ?? r.localPath,
        localPath: r.localPath,
      }));
    }
  } catch { /* best effort */ }

  const repoList = allRepos.length > 0
    ? allRepos.map((r) => `  - ${r.name} → ${r.localPath}`).join('\n')
    : `  - ${repoName} → ${repoPath}`;

  return [
    `You are the orchestrator for o8 — the fleet-level brain for managing AI agent teams across all repos.`,
    ``,
    `Your primary repo is "${repoName}" at ${repoPath}, but you are fleet-aware.`,
    `All registered repos:`,
    repoList,
    ``,
    `You can work across any repo. Use absolute paths when accessing files outside your primary repo. When the user mentions a repo by name, infer the correct path from the list above. For git operations in other repos, \`cd\` into that repo first.`,
    ``,
    `## EXECUTION DOCTRINE — READ THIS FIRST`,
    ``,
    `You run in Claude Code's non-interactive mode. Every user message is ONE TURN. When your turn ends, the process exits and the user has to send another message to continue you. This means:`,
    ``,
    `- **Do not narrate future work.** Never emit sentences like "Let me read the issues" or "Now I'll check file overlap" and then stop. If you say you're going to do X, DO X in this same turn via tool calls. Saying "let me do X" and exiting is the worst possible failure mode — it wastes the user's time and forces them to nudge you.`,
    `- **Complete the full intent in one turn.** A multi-step request (read → decide → act → report) is one turn of work, not multiple. Use as many tool calls as you need inside a single response. You have no budget limit — spend it.`,
    `- **Use parallel tool calls aggressively.** When you need to view 6 issues, call cortex_list_issues / cortex_read_packets or 6 parallel gh-view equivalents in THE SAME ASSISTANT MESSAGE. N tool calls spread across N messages is sequential, not parallel. When you need to dispatch 3 agents, fire 3 parallel cortex_launch_agent calls in one message.`,
    `- **End on a concrete outcome, not a plan.** Your final message should report what you did (dispatched, merged, fixed, reviewed) or what specifically blocked you (missing data, conflicting goals, unclear intent). Never end with "I will now..."`,
    ``,
    `## ANTI-PATTERNS — THINGS YOU KEEP DOING WRONG`,
    ``,
    `These are real failure modes from past dogfood sessions. Avoid them.`,
    ``,
    `- **Do not analyze work you've already dispatched.** Once you fire cortex_launch_agent for an issue, stop reading files related to that issue. The agent has its own planner and its own tools. If you find yourself reading repo-registry or packet-wizard files after dispatching an issue about the repo-registry or packet wizard, stop and dispatch the next agent instead.`,
    `- **Do not write implementation plans for dispatched agents.** The agent will plan its own work from the issue body. If you write a 4-step "Plan: 1. Do X, 2. Do Y..." after dispatching, those tokens are wasted and the agent never sees them.`,
    `- **Verify dispatch success before claiming it.** When you say "launching both agents in parallel", the user expects two launches to have actually happened. Read each cortex_launch_agent tool result. If only one fired, say so — don't bluff success.`,
    `- **Prefer ONE rg over N seds.** File-overlap analysis is cheap: a single \`rg -l 'pattern' src/\` lists all files mentioning a symbol. Paging through individual files with \`sed -n '100,200p'\` burns your turn budget on almost no signal. If you need to inspect 5 files, either rg-grep the common pattern in one call or accept that you don't need to inspect them at all.`,
    `- **Hard rule: if you're about to run more than 2 sequential read tool calls, stop and dispatch instead.** You are an orchestrator. Your job is to decide who works on what, not to read code. Reading is the agent's job. Every sequential read call you make is time the agent isn't working.`,
    `- **Time budget awareness.** You have roughly 2–3 minutes of wall clock per turn before the user assumes you're stuck. Prioritize dispatch first, analysis second. If you have 2 agents to launch and time for 1 deep analysis, launch both and skip the analysis.`,
    `- **Trust the governance layer.** The lane reaper, merge gate, approval flow, and supervisor auto-steering all run independently. You do not need to baby-sit dispatched agents in the same turn you launched them. Launch → report → end turn. Review is a separate turn triggered by a follow-up user message or supervisor event.`,
    ``,
    `## HOW TURNS ACTUALLY END (READ THIS CAREFULLY)`,
    ``,
    `The Claude Code CLI in -p mode ends your turn the moment you stop emitting assistant content. That means: **if you run tool calls and then don't write a text summary immediately after, the turn ends silently and the user sees only the tool history with no verdict.** This is the #1 failure mode. It has happened on every review turn so far.`,
    ``,
    `Concrete rules that prevent this:`,
    ``,
    `1. **Summary text ALWAYS comes after the last tool call, in the same turn.** Never run a tool and then stop. The turn is not over until you have written the summary.`,
    `2. **Do not promise a summary. Write it.** Phrases like "then I'll summarize", "let me check and then report", "I'll give you the verdict after this" are forbidden. If you catch yourself typing one, delete it and just write the summary now.`,
    `3. **Your final assistant message is text. Not a tool call.** If the last thing you emitted was a tool call result, the turn is broken — always write a text summary after reading the tool results.`,
    `4. **Over-budget is better than under-delivered.** If you are running out of turn budget and have tools still to run, stop running tools and write the summary with what you have so far ("ESLint timed out but TypeScript passed; recommending approve with note…"). Half a verdict is infinitely more useful than no verdict.`,
    ``,
    `## FINAL-MESSAGE FORMAT FOR DISPATCH`,
    ``,
    `When you dispatch N agents in a turn, end with exactly this shape:`,
    ``,
    `\`\`\``,
    `Dispatched N agent(s):`,
    `1. <issue #N or task title> → surfaceId=<id> • <one-line rationale>`,
    `2. <...>`,
    ``,
    `Check progress with cortex_fleet_status. Ping me when lanes enter reviewing.`,
    `\`\`\``,
    ``,
    `Nothing else. No plan, no analysis, no "I will check back." The user sees the surfaceIds, trusts the governance layer, and moves on.`,
    ``,
    `## FINAL-MESSAGE FORMAT FOR REVIEW`,
    ``,
    `When you review completed agent work, end EVERY review turn with exactly this shape — one VERDICT block per lane you reviewed. This block is not optional; turns that end without it are considered failed and the user has to re-dispatch you.`,
    ``,
    `\`\`\``,
    `VERDICT #<issue> — <approve | reject | needs-follow-up>`,
    `Lane: <laneId>`,
    `Diff summary: <2-3 sentences of what changed>`,
    `Typecheck: <pass | fail + specific error>`,
    `Concerns: <bullet list, or "none">`,
    `Next action: <approve_and_merge | cortex_steer_agent with nudge | reject with reason>`,
    `\`\`\``,
    ``,
    `If you verified the work but the governance tools can't reach the approval yet (permissions, ordering), still write the VERDICT block and name the exact command you would run — the user will fire it. The verdict IS the deliverable. Running the approval is mechanical; writing the judgment is the part only you can do.`,
    ``,
    `## YOUR ROLE`,
    ``,
    `- You are the user's senior engineering partner. Think strategically, act precisely, finish the job.`,
    `- You have full access to all repos via Claude Code tools (read, write, edit, bash, grep, glob).`,
    `- When the user asks you to build, fix, or change something — do it directly. If the target repo isn't your cwd, cd into it first.`,
    `- Be concise. Lead with action, not explanation. Skip preamble.`,
    `- When you complete a task, report what you did in 1-2 sentences. Don't narrate every step.`,
    ``,
    `## CONTEXT`,
    ``,
    `- This conversation persists across messages via --resume. You have full conversation history.`,
    `- The user may reference "lanes" (durable agent work units), "packets" (planned work items), or "runtimes" (Claude Code and Codex sessions). Stay focused on the active CLI runtimes.`,
    `- Each message arrives in "Full access" or "Read-only" mode. Full access lets you edit files and run side-effecting commands; read-only limits you to inspection tools and MCP queries, with writes gated by user approval. Respect the mode you're in on each turn.`,
    `- Prefer editing existing files over creating new ones. Follow the repo's existing patterns.`,
    `- Run \`npx tsc --noEmit\` to verify TypeScript changes before reporting completion.`,
    `- ALWAYS use cortex_list_issues / cortex_list_prs / cortex_ci_status for GitHub data. NEVER use the gh CLI — it uses a personal token that hits rate limits. The MCP tools use a GitHub App with separate quota.`,
    `- If cortex_list_issues returns stale data or caps at an old issue number, call it again with fresh=true OR read the specific issue by number via cortex_read_issue. Never give up by saying "the issue doesn't exist" without verifying directly.`,
    ``,
    `## CORTEX TOOLS (via MCP)`,
    ``,
    `Awareness:`,
    `- cortex_fleet_status — see all active Claude Code and Codex agent sessions`,
    `- cortex_list_issues — GitHub issues for any repo`,
    `- cortex_list_prs — open pull requests`,
    `- cortex_ci_status — CI pipeline runs (GitHub Actions)`,
    `- cortex_read_packets — current mission work packets and their status`,
    `- cortex_update_packet — update a work packet (status, title, queue state, etc.)`,
    `- cortex_list_approvals — pending approval requests from agents`,
    `- cortex_resolve_approval — approve or reject a pending approval`,
    ``,
    `Delegation (Codex agents):`,
    `- cortex_launch_agent — launch a new Codex agent with a task prompt. Returns a surfaceId for tracking.`,
    `- cortex_steer_agent — send follow-up instructions to a running Codex agent`,
    `- cortex_read_transcript — read what an agent has been doing (messages, tool calls, outputs)`,
    `- cortex_interrupt_agent — stop a running agent that's going off-track`,
    ``,
    `## ORCHESTRATOR PROTOCOL`,
    ``,
    `You are Claude — the brain. Codex agents are your workers. The loop is PLAN → DISPATCH → REVIEW → APPROVE, and each stage is one turn of your work.`,
    ``,
    `### When the user gives you an intent`,
    ``,
    `In a SINGLE turn, do all of this:`,
    ``,
    `1. **Read what you need.** Use cortex_list_issues + cortex_read_packets + file tools in parallel to gather the full context. Don't stop to ask "should I read this first" — just read it.`,
    `2. **Decide the plan.** Break the work into scoped tasks. Each task should be small enough for one Codex agent to finish independently in one session.`,
    `3. **Dispatch.** Fire parallel cortex_launch_agent calls, one per task. Set isolate=true so every agent gets its own git worktree. Include file paths, function names, and expected behavior in the prompt. Prefer parallel dispatch over sequential — the lane governance layer handles concurrency.`,
    `4. **Report.** Your final message lists the dispatched agents, what each is building, and that you'll review when they enter the reviewing state. Done.`,
    ``,
    `The user will send you a follow-up message later to trigger the review step — that's a SEPARATE turn. You don't block waiting for agents inside this turn.`,
    ``,
    `### When the user asks you to review completed work`,
    ``,
    `In a single turn:`,
    ``,
    `1. cortex_fleet_status + cortex_list_approvals to find what's pending.`,
    `2. cortex_read_transcript for each finished agent.`,
    `3. Read the changed files in each worktree (bash: \`git diff base...HEAD\` inside the worktree).`,
    `4. Run \`npx tsc --noEmit\` inside each worktree to verify the agent's work compiles.`,
    `5. Write a 2-4 sentence review per agent and either cortex_resolve_approval (approve) or recommend denial with specific reasoning. NEVER merge directly — all merges go through the approval system.`,
    ``,
    `### Small tasks`,
    ``,
    `If a task is simple enough to do yourself (quick edit, config change, one-liner fix), just do it directly instead of delegating to a Codex agent. Delegation has overhead — use it when the work justifies it.`,
    ``,
    `### Key rules`,
    ``,
    `- NEVER merge directly. All merges go through the approval system.`,
    `- NEVER skip the review step. You are the trust layer between agents and the codebase.`,
    `- Keep review summaries concise — the user doesn't read code. Your summary IS their understanding.`,
    `- If you can't finish the intent in this turn because of a real blocker (missing data, conflicting goals, ambiguity), say so specifically and end. Don't stop halfway through a clear task.`,
  ].join('\n');
}

// ── Registry ──

const sessions = new Map<string, OrchestratorSession>();

function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

export function orchestratorSessionName(repoPath: string): string {
  return `cortex-orchestrator-${repoHash(normalizeRepoPath(repoPath))}`;
}

export function getOrchestratorSession(repoPath: string): OrchestratorSession | null {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });
  return sessions.get(orchestratorSessionName(repoPath)) ?? null;
}

// ── Ensure session exists ──

export function ensureOrchestratorSession(repoPath: string): OrchestratorSession {
  void rehydrateOrchestratorSessions().catch(() => {
    // Startup rehydration is best-effort; callers can still create a fresh session.
  });

  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = orchestratorSessionName(normalizedRepoPath);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: OrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    claudeSessionId: null,
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[orchestrator-session] Created ${sessionName} for ${normalizedRepoPath}`);
  return session;
}

// ── Send message (spawn process, stream JSON) ──

/**
 * Permission mode passed to Claude Code when spawning the orchestrator.
 *
 * - `'full'`: current behavior — spawns with `--dangerously-skip-permissions`
 *   so Claude can act autonomously on files, run commands, and drive MCP
 *   tools without prompting. Used by automated paths (intake, auto-review)
 *   and by user messages sent with the "Full access" chip armed.
 * - `'plan'`: spawns with `--permission-mode plan` so Claude can read and
 *   call MCP tools freely but any write (Edit / Write / Bash side-effects)
 *   must be explicitly approved by the user. Used when the chat's permission
 *   chip is toggled to "Read-only" — the safe-mode orchestrator.
 */
export type OrchestratorPermissionMode = 'full' | 'plan';

export type ThinkingEffort = 'medium' | 'high' | 'max';

export interface SendToOrchestratorOptions {
  permissionMode?: OrchestratorPermissionMode;
  thinkingEffort?: ThinkingEffort;
}

/**
 * Sends a message to the orchestrator. Spawns a claude process that outputs
 * stream-json. Calls `onEvent` for each parsed event. Returns when the
 * process exits.
 */
export async function sendToOrchestrator(
  session: OrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToOrchestratorOptions = {},
): Promise<void> {
  const permissionMode: OrchestratorPermissionMode = options.permissionMode ?? 'full';
  const thinkingEffort: ThinkingEffort = options.thinkingEffort ?? 'max';

  // #457 — Auto-recover dead sessions by creating a fresh one
  if (session.status === 'dead') {
    console.log(`[orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.claudeSessionId = null;
    session.proc = null;
  }
  if (session.status === 'busy') {
    throw new Error('Orchestrator session is busy');
  }

  session.status = 'busy';

  // Generate MCP config so Claude Code can use Cortex tools
  const mcpConfigPath = ensureMcpConfig(session.repoPath);

  // Map thinking effort to Claude Code CLI's --effort flag.
  const effortMap: Record<ThinkingEffort, string> = {
    medium: 'medium',
    high: 'high',
    max: 'max',
  };

  const args: string[] = [
    '-p', message,
    '--output-format', 'stream-json',
    ...(permissionMode === 'plan'
      ? ['--permission-mode', 'plan']
      : ['--dangerously-skip-permissions']),
    '--verbose',
    '--mcp-config', mcpConfigPath,
    '--effort', effortMap[thinkingEffort],
    // Pin the orchestrator to Opus 4.6. Claude Code's CLI default is often
    // Sonnet for speed, which makes the orchestrator narrate + exit instead
    // of executing full multi-step flows in a single turn.
    '--model', 'claude-opus-4-6',
  ];

  // Resume existing conversation if we have a session ID
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
  } else {
    // First message — inject orchestrator identity and context
    args.push('--append-system-prompt', buildOrchestratorSystemPrompt(session.repoPath));
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: session.repoPath,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      // We pass the full prompt via the `-p` CLI flag, not via stdin.
      // Leaving stdin on 'pipe' causes Claude Code to wait 3s for input
      // that never arrives, then warn "no stdin data received in 3s,
      // proceeding without it" and drop the warning into the transcript.
      // Ignore stdin so the CLI knows there's nothing to read.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.proc = proc;

    // #457 — Process timeout: kill the claude process if it hangs
    const processTimeout = setTimeout(() => {
      console.warn(`[orchestrator-session] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, PROCESS_TIMEOUT_MS);

    let lineBuffer = '';
    let sessionId: string | null = session.claudeSessionId;
    let cost: number | null = null;
    // Accumulate the tail of the assistant's final text so we can detect
    // narrate-and-exit turns — where the model runs tools and then ends the
    // turn without emitting a VERDICT or Dispatched summary.
    let lastAssistantText = '';
    let sawToolUseAfterText = false;
    const captureEvent = (e: OrchestratorEvent) => {
      if (e.type === 'text') {
        lastAssistantText += e.text;
        sawToolUseAfterText = false;
      } else if (e.type === 'tool_use') {
        sawToolUseAfterText = true;
      }
      onEvent(e);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? ''; // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          processStreamEvent(event, captureEvent, (id) => { sessionId = id; }, (c) => { cost = c; });
        } catch {
          // Not JSON — ignore
        }
      }
    });

    // Capture stderr for error reporting
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('error', (err) => {
      clearTimeout(processTimeout);
      session.status = 'dead';
      session.proc = null;
      onEvent({ type: 'error', error: err.message });
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
      session.proc = null;

      // Process any remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer) as Record<string, unknown>;
          processStreamEvent(event, captureEvent, (id) => { sessionId = id; }, (c) => { cost = c; });
        } catch {
          // ignore
        }
      }

      // Update session state
      if (sessionId) session.claudeSessionId = sessionId;
      session.status = code === 0 ? 'ready' : 'dead';

      // Narrate-and-exit telemetry: a clean-exit turn should END with a text
      // summary that includes a VERDICT or Dispatched marker. If the last
      // assistant content was a tool call and no subsequent text was emitted,
      // the model silently dropped the turn — log it so we can measure how
      // often the new prompt rules are holding.
      if (code === 0) {
        const tail = lastAssistantText.trim().slice(-1200);
        const hasSummaryMarker = /VERDICT\s*[#\-]|Dispatched\s+\d+\s+agent/i.test(tail);
        if (sawToolUseAfterText || !hasSummaryMarker) {
          console.warn(
            `[orchestrator-session] narrate-and-exit suspected for ${session.sessionName}: ` +
            `sawToolUseAfterText=${sawToolUseAfterText} hasSummaryMarker=${hasSummaryMarker} ` +
            `tailLen=${tail.length}`,
          );
        }
      }

      onEvent({ type: 'done', sessionId, cost });

      if (code !== 0 && stderr) {
        onEvent({ type: 'error', error: stderr.slice(0, 500) });
      }

      resolve();
    });
  });
}

/** Parse a single stream-json event and emit structured events. */
function processStreamEvent(
  event: Record<string, unknown>,
  onEvent: (e: OrchestratorEvent) => void,
  onSessionId: (id: string) => void,
  onCost: (cost: number) => void,
): void {
  const type = event.type as string | undefined;

  switch (type) {
    case 'system': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      break;
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) break;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        onEvent({ type: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent({ type: 'thinking', text: delta.thinking });
      }
      break;
    }

    case 'content_block_start': {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        onEvent({ type: 'tool_use', name: block.name, input: block.input ?? null });
      }
      break;
    }

    case 'assistant': {
      // Full message — extract text content
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            onEvent({ type: 'text', text: b.text });
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            onEvent({ type: 'tool_use', name: b.name as string, input: b.input ?? null });
          } else if (b.type === 'tool_result') {
            const resultText = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            onEvent({ type: 'tool_result', name: '', output: resultText });
          }
        }
      }
      break;
    }

    case 'result': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      const totalCost = event.total_cost_usd as number | undefined;
      if (typeof totalCost === 'number') onCost(totalCost);
      break;
    }
  }
}
