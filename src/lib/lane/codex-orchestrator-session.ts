/**
 * Codex orchestrator session — sibling to orchestrator-session.ts that spawns
 * `codex exec --json` instead of `claude -p`. Used as the default after the
 * Anthropic SDK pricing change (June 15 2026) so the default install doesn't
 * burn the operator's Agent SDK credit pool.
 *
 * Uses a per-repo sandbox CODEX_HOME with a merged config.toml so Codex can
 * call the same operator + cortex MCP tools as the Claude orchestrator path.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OrchestratorEvent } from './orchestrator-stream-events';
import { getMcpServersConfig } from './orchestrator-mcp-config';
import type { OrchestratorMcpServersConfig } from './orchestrator-mcp-config';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  readOrchestratorBackendSessionId,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodexOrchestratorSession {
  sessionName: string;
  repoPath: string;
  /** UI/history thread id (thoughts-*), when this session belongs to a persisted chat. */
  historyThreadId: string | null;
  /** Codex thread id captured from the `thread.started` event for `exec resume`. */
  threadId: string | null;
  status: 'ready' | 'busy' | 'dead';
  proc: ChildProcess | null;
  createdAt: number;
}

// Mirror of OrchestratorPermissionMode from orchestrator-session.ts.
export type CodexOrchestratorPermissionMode = 'full' | 'plan';

export interface SendToCodexOrchestratorOptions {
  permissionMode?: CodexOrchestratorPermissionMode;
  thinkingEffort?: ThinkingEffort;
  model?: string;
  signal?: AbortSignal;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
/** Mirror of orchestrator-session.ts PROCESS_TIMEOUT_MS (4 hr — hang watchdog, not a work budget). */
const PROCESS_TIMEOUT_MS = 14_400_000;
/** Mirror of orchestrator-session.ts PREEMPT_SETTLE_MS — see that file for why. */
const PREEMPT_SETTLE_MS = 4_000;

/** Poll until the session leaves 'busy' (a turn closed) or the window elapses. */
async function waitForCodexOrchestratorIdle(session: CodexOrchestratorSession, timeoutMs: number): Promise<void> {
  if (session.status !== 'busy') return;
  const deadline = Date.now() + timeoutMs;
  while (session.status === 'busy' && Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
}
const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_CODEX_CONFIG_PATH = join(USER_CODEX_HOME, 'config.toml');
const CODEX_ORCHESTRATOR_HOME_DIR = join(
  process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8'),
  'codex-orchestrator',
);

// gpt-5.5 pricing — matches the entry in codex-cost-parser.ts that we added in
// v0.1.134. Duplicated here so we can report cost on `done` without a runtime
// import cycle.
const GPT_5_5_INPUT_USD_PER_MILLION = 2.5;
const GPT_5_5_CACHED_INPUT_USD_PER_MILLION = 0.25;
const GPT_5_5_OUTPUT_USD_PER_MILLION = 15;

// ── Registry ─────────────────────────────────────────────────────────────────

const sessions = new Map<string, CodexOrchestratorSession>();

function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
}

function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

function normalizeHistoryThreadId(threadId?: string | null): string | null {
  const trimmed = threadId?.trim() ?? '';
  return trimmed.startsWith('thoughts-') ? trimmed : null;
}

function historyThreadKey(threadId?: string | null): string | null {
  const normalized = normalizeHistoryThreadId(threadId);
  return normalized ? normalized.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) : null;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function isManagedMcpSection(sectionName: string, serverNames: string[]): boolean {
  return serverNames.some((name) => {
    const bare = `mcp_servers.${name}`;
    const quoted = `mcp_servers.${tomlKey(name)}`;
    return sectionName === bare
      || sectionName.startsWith(`${bare}.`)
      || sectionName === quoted
      || sectionName.startsWith(`${quoted}.`);
  });
}

function stripManagedMcpSections(configToml: string, serverNames: string[]): string {
  if (!configToml.trim()) {
    return '';
  }

  const lines = configToml.replace(/\r\n/g, '\n').split('\n');
  const nextLines: string[] = [];
  let skippingManagedSection = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (sectionMatch) {
      skippingManagedSection = isManagedMcpSection(sectionMatch[1].trim(), serverNames);
    }
    if (!skippingManagedSection) {
      nextLines.push(line);
    }
  }

  return nextLines.join('\n').trimEnd();
}

function serializeStringMap(sectionName: string, values: Record<string, string> | undefined): string[] {
  if (!values || Object.keys(values).length === 0) {
    return [];
  }

  return [
    `[${sectionName}]`,
    ...Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`),
  ];
}

function serializeCodexMcpServers(servers: OrchestratorMcpServersConfig): string {
  const lines: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (lines.length > 0) {
      lines.push('');
    }

    const serverSection = `mcp_servers.${tomlKey(name)}`;
    lines.push(`[${serverSection}]`);
    if (server.type === 'http') {
      lines.push('type = "http"');
      lines.push(`url = ${tomlString(server.url)}`);
      const headerLines = serializeStringMap(`${serverSection}.headers`, server.headers);
      if (headerLines.length > 0) {
        lines.push('', ...headerLines);
      }
      continue;
    }

    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = ${tomlStringArray(server.args)}`);
    const envLines = serializeStringMap(`${serverSection}.env`, server.env);
    if (envLines.length > 0) {
      lines.push('', ...envLines);
    }
  }

  return lines.join('\n');
}

function mergeCodexMcpConfig(baseConfigToml: string, servers: OrchestratorMcpServersConfig): string {
  const serverNames = Object.keys(servers);
  const retainedConfig = stripManagedMcpSections(baseConfigToml, serverNames);
  const mcpConfig = serializeCodexMcpServers(servers);
  return `${[retainedConfig, mcpConfig].filter(Boolean).join('\n\n')}\n`;
}

function syncCodexAuthFiles(codexHome: string): void {
  for (const fileName of ['auth.json', 'installation_id', 'version.json']) {
    const sourcePath = join(USER_CODEX_HOME, fileName);
    if (!existsSync(sourcePath)) {
      continue;
    }

    const destPath = join(codexHome, fileName);
    copyFileSync(sourcePath, destPath);
    if (fileName === 'auth.json') {
      chmodSync(destPath, 0o600);
    }
  }
}

export function ensureCodexHome(repoPath: string): string {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const codexHome = join(CODEX_ORCHESTRATOR_HOME_DIR, repoHash(normalizedRepoPath));
  mkdirSync(codexHome, { recursive: true });

  const userConfigToml = existsSync(USER_CODEX_CONFIG_PATH)
    ? readFileSync(USER_CODEX_CONFIG_PATH, 'utf8')
    : '';
  const mergedConfig = mergeCodexMcpConfig(
    userConfigToml,
    getMcpServersConfig(normalizedRepoPath),
  );
  const configPath = join(codexHome, 'config.toml');
  writeFileSync(configPath, mergedConfig, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
  syncCodexAuthFiles(codexHome);
  return codexHome;
}

export function codexOrchestratorSessionName(repoPath: string, threadId?: string | null): string {
  const threadSuffix = historyThreadKey(threadId);
  return `cortex-codex-orchestrator-${repoHash(normalizeRepoPath(repoPath))}${threadSuffix ? `-${threadSuffix}` : ''}`;
}

export function getCodexOrchestratorSession(repoPath: string, threadId?: string | null): CodexOrchestratorSession | null {
  return sessions.get(codexOrchestratorSessionName(repoPath, threadId)) ?? null;
}

export function ensureCodexOrchestratorSession(repoPath: string, threadId?: string | null): CodexOrchestratorSession {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedThreadId = normalizeHistoryThreadId(threadId);
  const sessionName = codexOrchestratorSessionName(normalizedRepoPath, normalizedThreadId);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: CodexOrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    historyThreadId: normalizedThreadId,
    threadId: readOrchestratorBackendSessionId(normalizedThreadId, 'codex'),
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[codex-orchestrator-session] Created ${sessionName} for ${normalizedRepoPath}${normalizedThreadId ? ` (${normalizedThreadId})` : ''}`);
  return session;
}

// ── Permission mode mapping ──────────────────────────────────────────────────

function sandboxFlagsForMode(mode: CodexOrchestratorPermissionMode): string[] {
  // These flags go to both `codex exec` (first turn) and `codex exec resume`
  // (every turn after). `resume` rejects the `-s` short flag — passing it broke
  // every multi-turn conversation — so the read-only sandbox is set via a `-c`
  // config override, which both subcommands honor.
  if (mode === 'plan') {
    // Read-only sandbox — codex can read repo state and call MCP read methods
    // but cannot edit files or run side-effecting shell commands.
    return ['-c', 'sandbox_mode=read-only'];
  }
  // 'full' — autonomous mode for auto-review + intake.
  // `--dangerously-bypass-approvals-and-sandbox` bypasses approvals + the
  // sandbox and is accepted by `codex exec resume` (unlike `-s`).
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

function reasoningEffortFromThinkingEffort(effort: ThinkingEffort | undefined): string {
  if (!effort || effort === 'adaptive') return 'xhigh';
  // Codex effort levels per ~/.codex/models_cache.json: minimal, low, medium,
  // high, xhigh. Our ThinkingEffort uses: low, medium, high, max, xhigh —
  // 'max' maps to xhigh because Codex doesn't have a 'max' tier.
  if (effort === 'max') return 'xhigh';
  return effort;
}

// ── Event mapping (codex JSON → OrchestratorEvent) ───────────────────────────

interface ParsedCodexLine {
  type?: string;
  thread_id?: string;
  payload?: Record<string, unknown>;
  item?: Record<string, unknown>;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

function safeObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function computeUsdCost(usage: ParsedCodexLine['usage']): number | null {
  if (!usage) return null;
  const inputTokens = Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0));
  const cachedTokens = usage.cached_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const total =
    (inputTokens / 1_000_000) * GPT_5_5_INPUT_USD_PER_MILLION
    + (cachedTokens / 1_000_000) * GPT_5_5_CACHED_INPUT_USD_PER_MILLION
    + (outputTokens / 1_000_000) * GPT_5_5_OUTPUT_USD_PER_MILLION;
  return Number.isFinite(total) && total > 0 ? total : null;
}

// ── Send message ─────────────────────────────────────────────────────────────

export async function sendToCodexOrchestrator(
  session: CodexOrchestratorSession,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: SendToCodexOrchestratorOptions = {},
): Promise<void> {
  const permissionMode: CodexOrchestratorPermissionMode = options.permissionMode ?? 'full';
  const model = options.model?.trim() || DEFAULT_CODEX_MODEL;
  const reasoningEffort = reasoningEffortFromThinkingEffort(options.thinkingEffort);

  // Steer-Now / queue preempt: the ws-server aborts the prior turn's
  // controller before calling sendTurn, so a still-'busy' session here is a
  // just-interrupted subprocess mid-teardown. Wait for it to close rather than
  // dropping the steered message. See orchestrator-session.ts for the full why.
  if (session.status === 'busy') {
    await waitForCodexOrchestratorIdle(session, PREEMPT_SETTLE_MS);
  }

  // A SIGTERM'd turn exits non-zero → 'dead', so the settle wait above commonly
  // lands here; auto-recover into a fresh turn.
  if (session.status === 'dead') {
    console.log(`[codex-orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.threadId = null;
    session.proc = null;
  }
  // Still busy after the settle window — genuinely concurrent / hung. Reject.
  // The synchronous `session.status = 'busy'` claim below means a second waiter
  // that lost the race re-enters here and rejects instead of double-spawning.
  if (session.status === 'busy') {
    throw new Error('Codex orchestrator session is busy');
  }

  session.status = 'busy';
  let codexHome: string;
  try {
    codexHome = ensureCodexHome(session.repoPath);
  } catch (err) {
    session.status = 'dead';
    const note = `Failed to prepare Codex MCP config: ${err instanceof Error ? err.message : String(err)}`;
    onEvent({ type: 'error', error: note });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }

  const { resolveCli, CliNotFoundError } = await import('@/lib/runtimes/shared/cli-resolver');
  let codexBin: string;
  try {
    const resolved = await resolveCli({
      runtimeId: 'codex',
      binaryName: 'codex',
      envOverride: 'O8_CODEX_BIN',
      extraEnvOverrides: ['CODEX_HOME'],
    });
    codexBin = resolved.path;
  } catch (err) {
    session.status = 'dead';
    const note = err instanceof CliNotFoundError
      ? `Codex binary not found: ${err.message}`
      : `Failed to resolve Codex binary: ${err instanceof Error ? err.message : String(err)}`;
    onEvent({ type: 'error', error: note });
    onEvent({ type: 'done', sessionId: session.threadId, cost: null });
    return;
  }

  // First-turn launch vs resume.
  const isResume = Boolean(session.threadId);
  const args: string[] = isResume
    ? [
        'exec',
        'resume',
        session.threadId!,
        '--json',
        ...sandboxFlagsForMode(permissionMode),
        '-c',
        `model=${model}`,
        '-c',
        `model_reasoning_effort=${reasoningEffort}`,
        // Disable the hosted image_generation tool (defaults to nonexistent
        // gpt-image-2 in Codex CLI 0.130.0 → 400s every turn at spawn).
        '-c',
        'tools.image_generation=false',
        '--',
        message,
      ]
    : [
        'exec',
        '--json',
        ...sandboxFlagsForMode(permissionMode),
        '-c',
        `model=${model}`,
        '-c',
        `model_reasoning_effort=${reasoningEffort}`,
        '-c',
        'tools.image_generation=false',
        '-C',
        session.repoPath,
        '--',
        message,
      ];

  return new Promise<void>((promiseResolve, promiseReject) => {
    const proc = spawn(codexBin, args, {
      cwd: session.repoPath,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        O8_MANAGED_SESSION: '1',
        CODEX_HOME: codexHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.proc = proc;

    const processTimeout = setTimeout(() => {
      console.warn(`[codex-orchestrator-session] Process timeout (${PROCESS_TIMEOUT_MS}ms) — killing ${session.sessionName}`);
      // Surface the kill to the chat — mirrors orchestrator-session.ts so the
      // user sees a small terminating note instead of a silent freeze.
      const minutes = Math.round(PROCESS_TIMEOUT_MS / 60_000);
      onEvent({
        type: 'error',
        error: `Orchestrator hit the ${minutes}-minute watchdog limit and was terminated — a turn running this long has almost certainly hung. Re-send your message to continue.`,
      });
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, PROCESS_TIMEOUT_MS);

    const userAbortSignal = options.signal;
    let userAbortListener: (() => void) | null = null;
    if (userAbortSignal) {
      if (userAbortSignal.aborted) {
        console.log(`[codex-orchestrator-session] Abort requested before spawn listener attached — killing ${session.sessionName}`);
        proc.kill('SIGTERM');
      } else {
        userAbortListener = () => {
          console.log(`[codex-orchestrator-session] User interrupt — killing ${session.sessionName}`);
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

    let lineBuffer = '';
    let cost: number | null = null;
    let threadId: string | null = session.threadId;

    proc.stdout?.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as ParsedCodexLine;
          const type = String(parsed.type ?? '');
          const payload = safeObject(parsed.payload);

          if (type === 'thread.started' && typeof parsed.thread_id === 'string') {
            threadId = parsed.thread_id;
            continue;
          }

          if (type === 'event_msg' && payload?.type === 'agent_message') {
            const text =
              typeof payload.message === 'string'
                ? payload.message
                : '';
            if (text) onEvent({ type: 'text', text });
            continue;
          }

          // Codex-cli 0.130.0 emits the assistant's reply as `item.completed`
          // with `item.type='agent_message'` and the body on `item.text`.
          // Older codex builds use the `event_msg` shape above; we accept both.
          const item = safeObject(parsed.item);
          if (type === 'item.completed' && item?.type === 'agent_message') {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text) onEvent({ type: 'text', text });
            continue;
          }

          if (type === 'item.completed' && item?.type === 'tool_use') {
            const name = typeof item.name === 'string' ? item.name : 'tool';
            let input: unknown = {};
            if (typeof item.arguments === 'string') {
              try {
                input = JSON.parse(item.arguments);
              } catch {
                input = item.arguments;
              }
            } else if (item.arguments && typeof item.arguments === 'object') {
              input = item.arguments;
            }
            onEvent({
              type: 'tool_use',
              id: typeof item.id === 'string' ? item.id : null,
              name,
              input,
            });
            continue;
          }

          if (type === 'item.completed' && item?.type === 'command_execution') {
            const cmd =
              typeof item.command === 'string'
                ? item.command
                : Array.isArray(item.command)
                  ? (item.command as string[]).join(' ')
                  : '';
            const output = typeof item.output === 'string' ? item.output : '';
            // Emit as a tool_use + tool_result pair so the UI renders the shell
            // call exactly like the legacy exec_command_begin/end pair would.
            const callId = typeof item.id === 'string' ? item.id : null;
            onEvent({ type: 'tool_use', id: callId, name: 'shell', input: { command: cmd } });
            if (output) {
              onEvent({ type: 'tool_result', id: callId, name: 'shell', output: output.slice(0, 4_000) });
            }
            continue;
          }

          if (type === 'event_msg' && payload?.type === 'exec_command_begin') {
            const command =
              typeof payload.command === 'string'
                ? payload.command
                : Array.isArray(payload.command)
                  ? (payload.command as string[]).join(' ')
                  : '';
            onEvent({
              type: 'tool_use',
              id: typeof payload.call_id === 'string' ? payload.call_id : null,
              name: 'shell',
              input: { command },
            });
            continue;
          }

          if (type === 'event_msg' && payload?.type === 'exec_command_end') {
            const output =
              typeof payload.stdout === 'string'
                ? payload.stdout
                : typeof payload.output === 'string'
                  ? payload.output
                  : '';
            onEvent({
              type: 'tool_result',
              id: typeof payload.call_id === 'string' ? payload.call_id : null,
              name: 'shell',
              output: output.slice(0, 4_000),
            });
            continue;
          }

          if (type === 'response_item' && payload?.type === 'reasoning') {
            const summary =
              typeof payload.summary === 'string'
                ? payload.summary
                : Array.isArray(payload.summary)
                  ? (payload.summary as string[]).join('\n')
                  : '';
            if (summary) onEvent({ type: 'thinking', text: summary });
            continue;
          }

          if (type === 'response_item' && payload?.type === 'function_call') {
            const name = typeof payload.name === 'string' ? payload.name : 'function';
            let input: unknown = {};
            if (typeof payload.arguments === 'string') {
              try {
                input = JSON.parse(payload.arguments);
              } catch {
                input = payload.arguments;
              }
            }
            onEvent({
              type: 'tool_use',
              id: typeof payload.call_id === 'string' ? payload.call_id : null,
              name,
              input,
            });
            continue;
          }

          if (type === 'response_item' && payload?.type === 'function_call_output') {
            const output = typeof payload.output === 'string' ? payload.output : '';
            // A screenshot tool's base64 is swamped + truncated; surface the
            // saved file path (o8_view_screenshot persists it) so the canvas can
            // SHOW the capture via serve-image.
            const shot = output.match(/\/tmp\/o8-screenshots\/[^\s"']+\.(?:png|jpe?g)/i);
            onEvent({
              type: 'tool_result',
              id: typeof payload.call_id === 'string' ? payload.call_id : null,
              name: typeof payload.name === 'string' ? payload.name : 'function',
              output: shot ? shot[0] : output.slice(0, 4_000),
            });
            continue;
          }

          if (type === 'turn.completed' && parsed.usage) {
            cost = computeUsdCost(parsed.usage);
            continue;
          }
        } catch {
          // Not JSON — ignore (codex sometimes emits banner/info lines pre-JSON)
        }
      }
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

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

      if (lineBuffer.trim()) {
        try {
          const parsed = JSON.parse(lineBuffer) as ParsedCodexLine;
          if (parsed.type === 'turn.completed' && parsed.usage) {
            cost = computeUsdCost(parsed.usage);
          }
        } catch {
          // ignore
        }
      }

      if (threadId) session.threadId = threadId;
      session.status = code === 0 ? 'ready' : 'dead';

      if (code !== 0) {
        // Always surface a non-zero exit — and BEFORE the done event, so
        // consumers don't treat the turn as a normal completion. A crash
        // with empty stderr used to produce a clean `done` and nothing else.
        onEvent({
          type: 'error',
          error: stderr.trim() ? stderr.slice(0, 500) : `codex exited with code ${code}`,
        });
      }

      onEvent({ type: 'done', sessionId: threadId, cost });

      promiseResolve();
    });
  });
}

/**
 * Reset the codex orchestrator session for a repo — forces the next call to
 * start a fresh codex thread instead of resuming. Used by the conversational
 * reload paths so a new MCP registration takes effect immediately.
 */
export function requestCodexOrchestratorSessionReset(repoPath: string, threadId?: string | null): {
  repoPath: string;
  sessionName: string;
  threadId: string | null;
} {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedThreadId = normalizeHistoryThreadId(threadId);
  const sessionName = codexOrchestratorSessionName(normalizedRepoPath, normalizedThreadId);
  const session = sessions.get(sessionName);
  if (session) {
    session.threadId = null;
  }
  if (normalizedThreadId) {
    writeOrchestratorBackendSessionId(normalizedThreadId, 'codex', null);
  }
  return { repoPath: normalizedRepoPath, sessionName, threadId: normalizedThreadId };
}
