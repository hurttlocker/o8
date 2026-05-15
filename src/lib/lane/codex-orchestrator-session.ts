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

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodexOrchestratorSession {
  sessionName: string;
  repoPath: string;
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
/** Mirror of orchestrator-session.ts PROCESS_TIMEOUT_MS (8 min). */
const PROCESS_TIMEOUT_MS = 480_000;
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

export function codexOrchestratorSessionName(repoPath: string): string {
  return `cortex-codex-orchestrator-${repoHash(normalizeRepoPath(repoPath))}`;
}

export function getCodexOrchestratorSession(repoPath: string): CodexOrchestratorSession | null {
  return sessions.get(codexOrchestratorSessionName(repoPath)) ?? null;
}

export function ensureCodexOrchestratorSession(repoPath: string): CodexOrchestratorSession {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = codexOrchestratorSessionName(normalizedRepoPath);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session: CodexOrchestratorSession = {
    sessionName,
    repoPath: normalizedRepoPath,
    threadId: null,
    status: 'ready',
    proc: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionName, session);
  console.log(`[codex-orchestrator-session] Created ${sessionName} for ${normalizedRepoPath}`);
  return session;
}

// ── Permission mode mapping ──────────────────────────────────────────────────

function sandboxFlagsForMode(mode: CodexOrchestratorPermissionMode): string[] {
  if (mode === 'plan') {
    // Read-only sandbox — codex can read repo state and call MCP read methods
    // but cannot edit files or run side-effecting shell commands.
    return ['-s', 'read-only'];
  }
  // 'full' — autonomous mode for auto-review + intake. Mirrors the codex
  // dispatch path used elsewhere in the codebase (owned.ts:227).
  return ['--dangerously-bypass-approvals-and-sandbox', '-s', 'danger-full-access'];
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

  if (session.status === 'dead') {
    console.log(`[codex-orchestrator-session] Auto-recovering dead session ${session.sessionName}`);
    session.status = 'ready';
    session.threadId = null;
    session.proc = null;
  }
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
            onEvent({
              type: 'tool_result',
              id: typeof payload.call_id === 'string' ? payload.call_id : null,
              name: typeof payload.name === 'string' ? payload.name : 'function',
              output: output.slice(0, 4_000),
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

      onEvent({ type: 'done', sessionId: threadId, cost });

      if (code !== 0 && stderr) {
        onEvent({ type: 'error', error: stderr.slice(0, 500) });
      }

      promiseResolve();
    });
  });
}

/**
 * Reset the codex orchestrator session for a repo — forces the next call to
 * start a fresh codex thread instead of resuming. Used by the conversational
 * reload paths so a new MCP registration takes effect immediately.
 */
export function requestCodexOrchestratorSessionReset(repoPath: string): {
  repoPath: string;
  sessionName: string;
} {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const sessionName = codexOrchestratorSessionName(normalizedRepoPath);
  const session = sessions.get(sessionName);
  if (session) {
    session.threadId = null;
  }
  return { repoPath: normalizedRepoPath, sessionName };
}
