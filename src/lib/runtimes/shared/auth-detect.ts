import 'server-only';

import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  ORCHESTRATOR_RUNTIMES,
  getRuntimeCapability,
  listDispatchableRuntimes,
  type RuntimeAuthHouse,
} from '@/lib/orchestrator/runtime-capabilities';
import { scanAndLink } from './cli-locate';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;

export type RuntimeHouse = RuntimeAuthHouse;
export type RuntimeUnavailableReason = 'not_installed' | 'needs_auth' | 'adapter_unavailable';

export interface RuntimeAuthStatus {
  house: RuntimeHouse | null;
  runtime: OrchestratorRuntime;
  installed: boolean;
  authenticated: boolean;
  unavailableReason: RuntimeUnavailableReason | null;
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

export interface DispatchableRuntimeAvailability {
  id: OrchestratorRuntime;
  label: string;
  available: boolean;
  unavailableReason: RuntimeUnavailableReason | null;
  detail: string;
  fix: string;
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
  update: Omit<RuntimeAuthStatus, 'house' | 'runtime' | 'checkedAt' | 'fix' | 'unavailableReason'> & {
    fix?: string;
    unavailableReason?: RuntimeUnavailableReason | null;
  },
): RuntimeAuthStatus {
  return {
    house,
    runtime,
    checkedAt: Date.now(),
    fix: update.fix ?? (house === 'codex' ? 'Run `codex login`.' : 'Run `claude` once to sign in.'),
    unavailableReason: update.unavailableReason
      ?? (!update.installed ? 'not_installed' : !update.authenticated ? 'needs_auth' : null),
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

async function detectGemini(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('gemini') ?? process.env.O8_GEMINI_BIN?.trim() ?? undefined;
  if (!binaryPath) {
    return nowStatus('gemini', 'gemini', {
      installed: false,
      authenticated: false,
      detail: 'Gemini CLI is not installed.',
      fix: 'Install Gemini CLI, then sign in or set GEMINI_API_KEY.',
    });
  }

  const home = os.homedir();
  const authenticated = Boolean(
    process.env.GEMINI_API_KEY
    || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    || process.env.GOOGLE_AI_API_KEY,
  ) || await fileExists(path.join(home, '.gemini', 'oauth_creds.json'));
  return nowStatus('gemini', 'gemini', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'Gemini CLI is installed and has local sign-in or API-key evidence.'
      : 'Gemini CLI is installed but no local sign-in or API-key evidence was found.',
    fix: 'Run `gemini` once to sign in or set GEMINI_API_KEY.',
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

async function detectPi(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('pi') ?? process.env.O8_PI_BIN?.trim() ?? undefined;
  if (!binaryPath) {
    return nowStatus('pi', 'pi', {
      installed: false,
      authenticated: false,
      detail: 'Pi CLI is not installed.',
      fix: 'Install Pi, then configure a provider with `pi`.',
    });
  }

  const authenticated = Boolean(
    process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  ) || await fileExists(path.join(os.homedir(), '.pi', 'agent', 'auth.json'));
  return nowStatus('pi', 'pi', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'Pi CLI is installed and has provider credentials.'
      : 'Pi CLI is installed but no provider credentials were found.',
    fix: 'Run `pi` and configure a provider before dispatching.',
    binaryPath,
  });
}

async function detectPrimeAgent(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('prime-agent') ?? process.env.O8_PRIME_AGENT_BIN?.trim() ?? undefined;
  if (!binaryPath) {
    return nowStatus('prime-agent', 'prime-agent', {
      installed: false,
      authenticated: false,
      detail: 'Prime Agent CLI is not installed.',
      fix: 'Install prime-agent, then configure a provider before dispatching.',
    });
  }

  const authenticated = Boolean(
    process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  ) || await fileExists(path.join(os.homedir(), '.prime'));
  return nowStatus('prime-agent', 'prime-agent', {
    installed: true,
    authenticated,
    detail: authenticated
      ? 'Prime Agent CLI is installed and has provider credentials.'
      : 'Prime Agent CLI is installed but no provider credentials were found.',
    fix: 'Configure a provider in prime-agent before dispatching.',
    binaryPath,
  });
}

async function detectDeclarativeRuntime(runtime: OrchestratorRuntime): Promise<RuntimeAuthStatus> {
  const capability = getRuntimeCapability(runtime);
  const manifest = capability.declarative;
  const house = capability.authHouse;
  if (!manifest || !house) {
    throw new Error(`Runtime ${runtime} has no declarative auth manifest.`);
  }
  const envToken = runtime.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  const binaryPath = scanAndLink(capability.binaryName)
    ?? process.env[`O8_${envToken}_BIN`]?.trim()
    ?? undefined;
  if (!binaryPath) {
    return nowStatus(house, runtime, {
      installed: false,
      authenticated: false,
      detail: `${capability.label} CLI is not installed.`,
      fix: manifest.authFix,
    });
  }

  const authenticated = manifest.authEnvVars.some((name) => Boolean(process.env[name]?.trim()))
    || (await Promise.all(manifest.authPaths.map((relativePath) => fileExists(path.join(os.homedir(), relativePath))))).some(Boolean);
  return nowStatus(house, runtime, {
    installed: true,
    authenticated,
    detail: authenticated
      ? `${capability.label} CLI is installed and has local credential evidence.`
      : `${capability.label} CLI is installed but no local credential evidence was found.`,
    fix: manifest.authFix,
    binaryPath,
  });
}

function detectRuntime(runtime: OrchestratorRuntime): Promise<RuntimeAuthStatus> {
  switch (runtime) {
    case 'codex': return detectCodex();
    case 'claude-code': return detectClaude();
    case 'gemini': return detectGemini();
    case 'opencode': return detectOpencode();
    case 'cursor': return detectCursor();
    case 'grok': return detectGrok();
    case 'pi': return detectPi();
    case 'prime-agent': return detectPrimeAgent();
    default: return detectDeclarativeRuntime(runtime);
  }
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
  const entries = await Promise.all(listDispatchableRuntimes().map(async (runtime) => {
    const house = getRuntimeCapability(runtime).authHouse;
    if (!house) throw new Error(`Dispatchable runtime ${runtime} has no auth house.`);
    return [house, await detectRuntime(runtime)] as const;
  }));
  const statuses = Object.fromEntries(entries) as Record<RuntimeHouse, RuntimeAuthStatus>;
  const snapshot = {
    statuses,
    suggestedSubscriptionProfile: suggestProfile(statuses),
  };
  cache = { snapshot, cachedAt: Date.now() };
  return snapshot;
}

function houseForRuntime(runtime: OrchestratorRuntime): RuntimeHouse | null {
  return getRuntimeCapability(runtime).authHouse;
}

export async function getDispatchableRuntimeAvailability(
  authSnapshot?: RuntimeAuthSnapshot,
): Promise<DispatchableRuntimeAvailability[]> {
  const [snapshot, runtimeRegistry] = await Promise.all([
    authSnapshot ?? getRuntimeAuthSnapshot(),
    import('@/lib/runtimes'),
  ]);

  return listDispatchableRuntimes().map((id) => {
    const adapter = runtimeRegistry.getRuntime(id);
    if (!adapter?.capabilities.launch) {
      return {
        id,
        label: ORCHESTRATOR_RUNTIMES[id].label,
        available: false,
        unavailableReason: 'adapter_unavailable' as const,
        detail: `${ORCHESTRATOR_RUNTIMES[id].label} does not have a launch-capable runtime adapter.`,
        fix: 'Install a build of o8 that includes this runtime adapter.',
      };
    }

    const house = houseForRuntime(id);
    const status = house ? snapshot.statuses[house] : null;
    const available = Boolean(status?.installed && status.authenticated);
    return {
      id,
      label: ORCHESTRATOR_RUNTIMES[id].label,
      available,
      unavailableReason: available ? null : status?.unavailableReason ?? 'adapter_unavailable',
      detail: status?.detail ?? `${ORCHESTRATOR_RUNTIMES[id].label} readiness could not be determined.`,
      fix: status?.fix ?? 'Check the runtime installation and credentials.',
    };
  });
}

export async function assertRuntimeDispatchable(runtime: OrchestratorRuntime): Promise<void> {
  const availability = (await getDispatchableRuntimeAvailability()).find((entry) => entry.id === runtime);
  if (availability?.available) return;

  const house = houseForRuntime(runtime);
  const snapshot = await getRuntimeAuthSnapshot();
  const status = house ? snapshot.statuses[house] : null;
  throw new DispatchPreflightError(status ?? {
    house,
    runtime,
    installed: false,
    authenticated: false,
    unavailableReason: availability?.unavailableReason ?? 'adapter_unavailable',
    detail: availability?.detail ?? `Runtime "${runtime}" is not dispatchable.`,
    fix: availability?.fix ?? 'Choose an available runtime.',
    checkedAt: Date.now(),
  });
}
