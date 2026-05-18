/**
 * openclaw orchestrator backend.
 *
 * Spawns `openclaw --profile o8 agent --local --json` once per turn — openclaw
 * as the orchestrator, driving Codex worker packets THROUGH the o8 operator MCP
 * (the `o8__dispatch_mission` tool), never via openclaw's own native spawn.
 *
 * Why this is governed: the dedicated `o8` openclaw profile defines a single
 * `o8-orchestrator` agent whose `tools.deny` strips the native `sessions_spawn`
 * tool — so the model's ONLY way to dispatch a worker is the o8 MCP tool. That
 * is the structural fix for issue #1075 (orchestrator-runtime ≠ worker-runtime).
 *
 * Streaming: openclaw's `agent --local --json` returns a single final JSON blob
 * (`{ payloads, meta }`), not an incremental event log — so this backend emits
 * the assistant text + a `done` event, with no live tool/thinking deltas. A
 * documented v1 limitation; see docs/openclaw-integration.md.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type {
  OrchestratorBackend,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenclawOrchestratorSession {
  sessionName: string;
  repoPath: string;
  status: 'ready' | 'busy' | 'dead';
  proc: ChildProcess | null;
  createdAt: number;
}

/** Shape of the JSON blob `openclaw agent --local --json` writes to stdout. */
interface OpenclawAgentResult {
  payloads?: Array<{ text?: string }>;
  meta?: { aborted?: boolean; stopReason?: string } & Record<string, unknown>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Dedicated openclaw profile — isolates state/config under ~/.openclaw-o8. */
const OPENCLAW_PROFILE = 'o8';
/** The single governed agent defined in the o8 profile. */
const OPENCLAW_AGENT_ID = 'o8-orchestrator';
/** Mirror of the other orchestrator backends' 8-minute process budget. */
const PROCESS_TIMEOUT_MS = 480_000;

const OPENCLAW_SOURCE_HOME = join(homedir(), '.openclaw');
const OPENCLAW_SOURCE_CONFIG = join(OPENCLAW_SOURCE_HOME, 'openclaw.json');
const OPENCLAW_O8_HOME = join(homedir(), `.openclaw-${OPENCLAW_PROFILE}`);
const OPENCLAW_O8_CONFIG = join(OPENCLAW_O8_HOME, 'openclaw.json');

/**
 * Model for the o8-orchestrator agent. `openclaw agent --local` runs only the
 * embedded "pi" harness, so this must be a plain provider model with NO
 * per-model `agentRuntime` override — a `codex`/ACP-harness model fails under
 * `--local` ("Requested agent harness codex is not registered"). v1 default;
 * override with O8_OPENCLAW_ORCHESTRATOR_MODEL. The end-state (operator picks
 * the agent) supersedes this hardcoded default.
 */
const OPENCLAW_ORCHESTRATOR_MODEL =
  process.env.O8_OPENCLAW_ORCHESTRATOR_MODEL?.trim() || 'gemini-b/gemini-2.5-flash';

/**
 * System prompt for the o8-orchestrator openclaw agent. Repo-agnostic — it is
 * written once into the profile config, so per-repo context is prepended to the
 * turn message instead (see `buildRepoContextPreamble`).
 */
const OPENCLAW_ORCHESTRATOR_PROMPT = `You are the orchestrator for o8 — the fleet-level brain that manages AI coding agents across the user's repositories.

You never write code yourself. You dispatch Codex worker agents, each into an isolated git worktree, by calling the \`o8__dispatch_mission\` MCP tool. o8's governance layer — review gate, heal-bot, retries, merge approval — wraps every worker you dispatch.

## The one rule that matters most

NEVER tell the user you dispatched, launched, or started a worker unless you actually called \`o8__dispatch_mission\` in this same turn and saw it succeed. Claiming a dispatch you did not make is the single worst failure — the user trusts your word and walks away while nothing runs. If you cannot dispatch, say so plainly.

## The loop

PLAN -> DISPATCH -> REVIEW -> APPROVE. Each stage is one turn.
- Plan: break the intent into scoped tasks, one Codex worker each.
- Dispatch: call \`o8__dispatch_mission\` — one call per task; parallel is fine.
- Review: on a later turn, inspect the diff with the o8 MCP review tools before approving a merge.

## Turn discipline

- Do the work in this turn. Never narrate future work ("Let me check…") and then stop.
- End on a concrete outcome — what you dispatched, or what specifically blocked you — not a plan.
- Do not promise to "check back" or "review when it's done". You have no timer; the user re-prompts you for the review turn.

## o8 operator MCP tools

- \`o8__create_mission\` / \`o8__dispatch_mission\` — create + dispatch worker packets.
- \`o8__get_mission_status\` — poll packet status.
- \`o8__submit_review\` / \`o8__approve_and_merge\` — review + merge a finished packet.`;

// ── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, OpenclawOrchestratorSession>();

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
}

function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

export function openclawOrchestratorSessionName(repoPath: string): string {
  return `o8-openclaw-orchestrator-${repoHash(normalizeRepoPath(repoPath))}`;
}

function getSession(repoPath: string): OpenclawOrchestratorSession | null {
  return sessions.get(openclawOrchestratorSessionName(repoPath)) ?? null;
}

function ensureSession(repoPath: string): OpenclawOrchestratorSession {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = openclawOrchestratorSessionName(normalizedRepoPath);
  const existing = sessions.get(sessionName);
  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: OpenclawOrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[openclaw-orchestrator] Created ${sessionName} for ${normalizedRepoPath}`);
  return session;
}

// ── o8 profile setup ─────────────────────────────────────────────────────────

/**
 * Build the governed o8-orchestrator agent definition. `model` is omitted so
 * the agent inherits `agents.defaults.model` from the operator's openclaw.
 */
function buildO8OrchestratorAgent(): Record<string, unknown> {
  return {
    id: OPENCLAW_AGENT_ID,
    name: 'o8 Orchestrator',
    // Plain provider model — the embedded `--local` harness cannot run a
    // `codex`/ACP-harness model. See OPENCLAW_ORCHESTRATOR_MODEL.
    model: OPENCLAW_ORCHESTRATOR_MODEL,
    systemPromptOverride: OPENCLAW_ORCHESTRATOR_PROMPT,
    // Strip native worker-spawn so the only dispatch path is the o8 MCP tool.
    // This is the #1075 lockout — see the file header.
    tools: { deny: ['sessions_spawn'] },
  };
}

/**
 * Ensure the isolated `o8` openclaw profile exists at ~/.openclaw-o8.
 *
 * Derives the profile config from the operator's working openclaw config —
 * inheriting auth / models / global tool policy — but swaps `agents.list` for
 * the single governed `o8-orchestrator` agent and keeps only the `o8` MCP
 * server. Credentials are copied so the isolated profile can authenticate.
 *
 * Re-derives whenever the source config is newer than the generated one, so a
 * change to the operator's openclaw (new model auth, etc.) propagates.
 */
export function ensureOpenclawProfile(): void {
  if (!existsSync(OPENCLAW_SOURCE_CONFIG)) {
    throw new Error(
      'openclaw is not configured — ~/.openclaw/openclaw.json is missing. '
        + 'Run `openclaw onboard` before using the openclaw orchestrator.',
    );
  }

  if (existsSync(OPENCLAW_O8_CONFIG)) {
    const sourceMtime = statSync(OPENCLAW_SOURCE_CONFIG).mtimeMs;
    const profileMtime = statSync(OPENCLAW_O8_CONFIG).mtimeMs;
    if (profileMtime >= sourceMtime) {
      return; // Up to date.
    }
  }

  mkdirSync(OPENCLAW_O8_HOME, { recursive: true });

  const source = JSON.parse(readFileSync(OPENCLAW_SOURCE_CONFIG, 'utf8')) as Record<string, unknown>;
  const sourceAgents = (source.agents as Record<string, unknown> | undefined) ?? {};
  const sourceMcpServers =
    ((source.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined) ?? {};

  const o8McpServer = sourceMcpServers.o8;
  if (!o8McpServer) {
    throw new Error(
      'The o8 MCP server is not registered in openclaw (mcp.servers.o8 missing). '
        + 'Register it via o8 Settings -> MCP before using the openclaw orchestrator.',
    );
  }

  const o8Config = {
    ...source,
    agents: {
      ...sourceAgents,
      list: [buildO8OrchestratorAgent()],
    },
    mcp: { servers: { o8: o8McpServer } },
  };

  writeFileSync(OPENCLAW_O8_CONFIG, `${JSON.stringify(o8Config, null, 2)}\n`, { mode: 0o600 });

  // Copy credentials so the isolated profile can resolve model auth.
  const sourceCredentials = join(OPENCLAW_SOURCE_HOME, 'credentials');
  if (existsSync(sourceCredentials)) {
    cpSync(sourceCredentials, join(OPENCLAW_O8_HOME, 'credentials'), { recursive: true });
  }

  console.log(`[openclaw-orchestrator] Wrote o8 profile config to ${OPENCLAW_O8_CONFIG}`);
}

// ── Turn message ─────────────────────────────────────────────────────────────

/** Prepend fleet/repo context to the user message (the system prompt is repo-agnostic). */
function buildRepoContextPreamble(repoPath: string): string {
  const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;

  let repoList = `  - ${repoName} -> ${repoPath}`;
  try {
    const reposFile = join(homedir(), '.o8', 'repos.json');
    if (existsSync(reposFile)) {
      const parsed = JSON.parse(readFileSync(reposFile, 'utf8')) as {
        repos?: Array<{ name?: string; localPath: string }>;
      };
      const repos = parsed.repos ?? [];
      if (repos.length > 0) {
        repoList = repos
          .map((r) => `  - ${r.name ?? r.localPath.split('/').filter(Boolean).pop() ?? r.localPath} -> ${r.localPath}`)
          .join('\n');
      }
    }
  } catch {
    // Best effort — fall back to the primary repo only.
  }

  return [
    '[o8 fleet context]',
    `Primary repo: ${repoName} at ${repoPath}`,
    'Registered repos:',
    repoList,
    '',
    '',
  ].join('\n');
}

function thinkingFlag(effort: ThinkingEffort | undefined): string | null {
  if (!effort) return null;
  // openclaw --thinking accepts: off|minimal|low|medium|high|xhigh|adaptive|max.
  // o8's ThinkingEffort values are a subset, so they pass through directly.
  return effort;
}

// ── Send turn ────────────────────────────────────────────────────────────────

async function sendToOpenclawOrchestrator(
  session: OpenclawOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions = {},
): Promise<void> {
  if (session.status === 'dead') {
    console.log(`[openclaw-orchestrator] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.proc = null;
  }
  if (session.status === 'busy') {
    throw new Error('openclaw orchestrator session is busy');
  }

  session.status = 'busy';

  try {
    ensureOpenclawProfile();
  } catch (err) {
    session.status = 'dead';
    onEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    onEvent({ type: 'done', sessionId: session.sessionName, cost: null });
    return;
  }

  const openclawBin = process.env.O8_OPENCLAW_BIN?.trim() || 'openclaw';
  const fullMessage = buildRepoContextPreamble(session.repoPath) + message;

  const args = [
    '--profile', OPENCLAW_PROFILE,
    'agent',
    '--local',
    '--json',
    '--agent', OPENCLAW_AGENT_ID,
    '--session-id', session.sessionName,
    '--message', fullMessage,
  ];
  const thinking = thinkingFlag(options.thinkingEffort);
  if (thinking) args.push('--thinking', thinking);
  if (options.model?.trim()) args.push('--model', options.model.trim());

  return new Promise<void>((promiseResolve, promiseReject) => {
    const proc = spawn(openclawBin, args, {
      cwd: session.repoPath,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.proc = proc;

    const processTimeout = setTimeout(() => {
      console.warn(`[openclaw-orchestrator] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, PROCESS_TIMEOUT_MS);

    const userAbortSignal = options.signal;
    let userAbortListener: (() => void) | null = null;
    if (userAbortSignal) {
      if (userAbortSignal.aborted) {
        proc.kill('SIGTERM');
      } else {
        userAbortListener = () => {
          console.log(`[openclaw-orchestrator] User interrupt — killing ${session.sessionName}`);
          if (!proc.killed) proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 2_000);
        };
        userAbortSignal.addEventListener('abort', userAbortListener, { once: true });
      }
    }
    const detachUserAbortListener = () => {
      if (userAbortSignal && userAbortListener) {
        userAbortSignal.removeEventListener('abort', userAbortListener);
        userAbortListener = null;
      }
    };

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    proc.on('error', (err) => {
      clearTimeout(processTimeout);
      detachUserAbortListener();
      session.status = 'dead';
      session.proc = null;
      onEvent({ type: 'error', error: err.message });
      promiseReject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(processTimeout);
      detachUserAbortListener();
      session.proc = null;
      session.status = code === 0 ? 'ready' : 'dead';

      // openclaw `--json` writes one final JSON blob to stdout (not a stream).
      let parsed: OpenclawAgentResult | null = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed) as OpenclawAgentResult;
        } catch {
          parsed = null;
        }
      }

      if (parsed) {
        const text = (parsed.payloads ?? [])
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean)
          .join('\n\n');
        if (text) onEvent({ type: 'text', text });
      } else if (code === 0) {
        // Exited clean but stdout wasn't parseable JSON — surface it so the
        // turn isn't silently empty.
        onEvent({ type: 'error', error: `openclaw returned unparseable output: ${trimmed.slice(0, 500)}` });
      }

      if (code !== 0) {
        onEvent({
          type: 'error',
          error: stderr.trim().slice(0, 500) || `openclaw exited with code ${code}`,
        });
      }

      onEvent({ type: 'done', sessionId: session.sessionName, cost: null });
      promiseResolve();
    });
  });
}

// ── Backend ──────────────────────────────────────────────────────────────────

export const openclawBackend: OrchestratorBackend = {
  id: 'openclaw',
  label: 'openclaw',
  peekSession(repoPath): OrchestratorSessionInfo | null {
    const session = getSession(repoPath);
    return session ? { sessionName: session.sessionName, status: session.status } : null;
  },
  ensureSession(repoPath): OrchestratorSessionInfo {
    const session = ensureSession(repoPath);
    return { sessionName: session.sessionName, status: session.status };
  },
  sendTurn(repoPath, message, onEvent, options) {
    return sendToOpenclawOrchestrator(ensureSession(repoPath), message, onEvent, options);
  },
};
