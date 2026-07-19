import 'server-only';

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { scanAndLink } from './cli-locate';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;

export type RuntimeHouse = 'codex' | 'claude' | 'opencode' | 'cursor' | 'grok';

export interface RuntimeAuthStatus {
  house: RuntimeHouse;
  runtime: OrchestratorRuntime;
  installed: boolean;
  authenticated: boolean;
  detail: string;
  fix: string;
  checkedAt: number;
  binaryPath?: string;
}

export interface MachineAuthProfileSuggestion {
  profile: 'claude-only' | 'codex-only' | null;
  detail: string | null;
}

export interface RuntimeAuthSnapshot {
  statuses: Record<RuntimeHouse, RuntimeAuthStatus>;
  suggestedSubscriptionProfile: MachineAuthProfileSuggestion;
}

class DispatchPreflightError extends Error {
  public readonly code = 'dispatch_cli_auth_unavailable';
  public readonly status: RuntimeAuthStatus;

  constructor(status: RuntimeAuthStatus) {
    super(status.detail);
    this.name = 'DispatchPreflightError';
    this.status = status;
  }
}

export { DispatchPreflightError };

let cache: { snapshot: RuntimeAuthSnapshot; cachedAt: number } | null = null;

function nowStatus(
  house: RuntimeHouse,
  runtime: OrchestratorRuntime,
  update: Omit<RuntimeAuthStatus, 'house' | 'runtime' | 'checkedAt' | 'fix'> & { fix?: string },
): RuntimeAuthStatus {
  return {
    house,
    runtime,
    checkedAt: Date.now(),
    fix: update.fix ?? (house === 'codex' ? 'Run `codex login`.' : 'Run `claude` once to sign in.'),
    ...update,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function probeCodexAuth(binaryPath: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['login', 'status'], {
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 64 * 1024,
    });
    return `${stdout}\n${stderr}`.toLowerCase().includes('logged in');
  } catch {
    return false;
  }
}

async function detectCodex(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('codex') ?? undefined;
  if (!binaryPath) {
    return nowStatus('codex', 'codex', {
      installed: false,
      authenticated: false,
      detail: 'Codex CLI is not installed.',
      fix: 'Install Codex, then run `codex login`.',
    });
  }

  const authFile = path.join(os.homedir(), '.codex', 'auth.json');
  const authJson = await readJsonRecord(authFile);
  const hasToken = Boolean(
    process.env.OPENAI_API_KEY
    || process.env.CODEX_ACCESS_TOKEN
    || (authJson?.tokens && typeof authJson.tokens === 'object'),
  );
  const cliSaysLoggedIn = await probeCodexAuth(binaryPath);
  return nowStatus('codex', 'codex', {
    installed: true,
    authenticated: cliSaysLoggedIn || hasToken,
    detail: cliSaysLoggedIn || hasToken
      ? 'Codex CLI is installed and signed in.'
      : 'Codex CLI is installed but not signed in.',
    binaryPath,
  });
}

async function detectClaude(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('claude') ?? undefined;
  if (!binaryPath) {
    return nowStatus('claude', 'claude-code', {
      installed: false,
      authenticated: false,
      detail: 'Claude Code CLI is not installed.',
      fix: 'Install Claude Code, then run `claude` once to sign in.',
    });
  }

  const home = os.homedir();
  const hasEnvAuth = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const settingsExists = await fileExists(path.join(home, '.claude', 'settings.json'));
  const credentialsExists = await fileExists(path.join(home, '.claude', '.credentials.json'));
  const projectHistoryExists = await fileExists(path.join(home, '.claude', 'projects'));
  const authenticated = hasEnvAuth || settingsExists || credentialsExists || projectHistoryExists;

  return nowStatus('claude', 'claude-code', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'Claude Code CLI is installed and has local sign-in evidence.'
      : 'Claude Code CLI is installed but no local sign-in evidence was found.',
    binaryPath,
  });
}

async function detectOpencode(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('opencode') ?? undefined;
  if (!binaryPath) {
    return nowStatus('opencode', 'opencode', {
      installed: false,
      authenticated: false,
      detail: 'opencode CLI is not installed.',
      fix: 'Install opencode, then run `opencode auth login`.',
    });
  }

  const authFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  const authenticated = await fileExists(authFile);
  return nowStatus('opencode', 'opencode', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'opencode CLI is installed and has local auth.json evidence.'
      : `opencode needs auth.json at ${authFile}.`,
    fix: 'Run `opencode auth login` to create auth.json.',
    binaryPath,
  });
}

async function detectCursor(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('cursor-agent') ?? undefined;
  if (!binaryPath) {
    return nowStatus('cursor', 'cursor', {
      installed: false,
      authenticated: false,
      detail: 'Cursor CLI is not installed.',
      fix: 'Install Cursor CLI, then run `cursor-agent login` or set CURSOR_API_KEY.',
    });
  }
  const authenticated = Boolean(process.env.CURSOR_API_KEY)
    || await fileExists(path.join(os.homedir(), '.cursor'));
  return nowStatus('cursor', 'cursor', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'Cursor CLI is installed and has local sign-in or CURSOR_API_KEY evidence.'
      : 'Cursor CLI is installed but no local sign-in evidence was found.',
    fix: 'Run `cursor-agent login` or set CURSOR_API_KEY.',
    binaryPath,
  });
}

async function detectGrok(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('grok') ?? undefined;
  if (!binaryPath) {
    return nowStatus('grok', 'grok', {
      installed: false,
      authenticated: false,
      detail: 'Grok Build CLI is not installed.',
      fix: 'Install Grok Build, then sign in or set GROK_CODE_XAI_API_KEY.',
    });
  }
  const authenticated = Boolean(process.env.GROK_CODE_XAI_API_KEY)
    || await fileExists(path.join(os.homedir(), '.grok'));
  return nowStatus('grok', 'grok', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'Grok Build CLI is installed and has local sign-in or GROK_CODE_XAI_API_KEY evidence.'
      : 'Grok Build CLI is installed but no local sign-in evidence was found.',
    fix: 'Sign in with Grok Build or set GROK_CODE_XAI_API_KEY.',
    binaryPath,
  });
}

function suggestProfile(statuses: Record<RuntimeHouse, RuntimeAuthStatus>): MachineAuthProfileSuggestion {
  const codexReady = statuses.codex.installed && statuses.codex.authenticated;
  const claudeReady = statuses.claude.installed && statuses.claude.authenticated;
  if (codexReady && !claudeReady) {
    return { profile: 'codex-only', detail: 'Only Codex is signed in on this machine.' };
  }
  if (claudeReady && !codexReady) {
    return { profile: 'claude-only', detail: 'Only Claude Code is signed in on this machine.' };
  }
  return { profile: null, detail: null };
}

export function invalidateRuntimeAuthCache(): void {
  cache = null;
}

export async function getRuntimeAuthSnapshot(): Promise<RuntimeAuthSnapshot> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) return cache.snapshot;
  const [codex, claude, opencode, cursor, grok] = await Promise.all([
    detectCodex(),
    detectClaude(),
    detectOpencode(),
    detectCursor(),
    detectGrok(),
  ]);
  const statuses = { codex, claude, opencode, cursor, grok };
  const snapshot = {
    statuses,
    suggestedSubscriptionProfile: suggestProfile(statuses),
  };
  cache = { snapshot, cachedAt: Date.now() };
  return snapshot;
}

function houseForRuntime(runtime: OrchestratorRuntime): RuntimeHouse | null {
  if (runtime === 'codex') return 'codex';
  if (runtime === 'claude-code') return 'claude';
  if (runtime === 'opencode') return 'opencode';
  if (runtime === 'cursor') return 'cursor';
  if (runtime === 'grok') return 'grok';
  return null;
}

export async function assertRuntimeDispatchable(runtime: OrchestratorRuntime): Promise<void> {
  const house = houseForRuntime(runtime);
  if (!house) return;
  const snapshot = await getRuntimeAuthSnapshot();
  const status = snapshot.statuses[house];
  if (!status.installed || !status.authenticated) {
    throw new DispatchPreflightError(status);
  }
}
