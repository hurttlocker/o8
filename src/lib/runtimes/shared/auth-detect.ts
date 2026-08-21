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
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import {
  localProviderIds,
  opencodeCredentialProviders,
  probeOpencodeServiceVersion,
  providerHasConfiguredCredential,
  providerIdForModel,
  readOpencodeConfig,
} from './opencode-readiness';
import {
  deepSeekHarnessInstallGuidance,
  resolveDeepSeekHarnessLaunch,
} from '@/lib/deepseek-harness/runtime-resolution';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;
const TRUSTED_KEYLESS_OPENCODE_MODELS = new Set([
  'opencode/deepseek-v4-flash-free',
]);

export type RuntimeHouse = RuntimeAuthHouse;
export type RuntimeUnavailableReason = 'not_installed' | 'needs_auth' | 'needs_restart' | 'adapter_unavailable';

export interface RuntimeAuthStatus {
  house: RuntimeHouse | null;
  runtime: OrchestratorRuntime;
  installed: boolean;
  /** True when the runtime can dispatch without a model-specific readiness check. */
  ready: boolean;
  /** Credential evidence only; a keyless local runtime can be ready while this is false. */
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
// The OpenCode probe alone spawns 2-3 subprocesses (up to PROBE_TIMEOUT_MS each), so it gets its
// own short TTL + in-flight coalescing on top of the general CACHE_TTL_MS cache below — otherwise
// every getRuntimeAuthSnapshot() call inside a fresh main-cache window re-probes it unconditionally.
let opencodeRefresh: { promise: Promise<RuntimeAuthStatus>; refreshedAt: number } | null = null;
const OPENCODE_REFRESH_TTL_MS = 10_000;

function nowStatus(
  house: RuntimeHouse,
  runtime: OrchestratorRuntime,
  update: Omit<RuntimeAuthStatus, 'house' | 'runtime' | 'checkedAt' | 'ready' | 'fix' | 'unavailableReason'> & {
    ready?: boolean;
    fix?: string;
    unavailableReason?: RuntimeUnavailableReason | null;
  },
): RuntimeAuthStatus {
  const ready = update.ready ?? update.authenticated;
  return {
    house,
    runtime,
    checkedAt: Date.now(),
    ...update,
    ready,
    fix: update.fix ?? (house === 'codex' ? 'Run `codex login`.' : 'Run `claude` once to sign in.'),
    unavailableReason: update.unavailableReason
      ?? (!update.installed ? 'not_installed' : !ready ? 'needs_auth' : null),
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

async function opencodeModelStatus(
  status: RuntimeAuthStatus,
  model: string,
  cwd?: string | null,
): Promise<RuntimeAuthStatus> {
  const providerId = providerIdForModel(model);
  if (!providerId) {
    return {
      ...status,
      authenticated: false,
      ready: false,
      unavailableReason: 'needs_auth',
      detail: 'The selected OpenCode 2 model does not identify its provider.',
      fix: 'Select an OpenCode 2 model using its provider/model identifier.',
    };
  }

  const [credentialProviders, config] = await Promise.all([
    opencodeCredentialProviders(os.homedir()),
    readOpencodeConfig(os.homedir(), cwd),
  ]);
  const localProviders = localProviderIds(config);
  const authenticated = credentialProviders.has(providerId)
    || providerHasConfiguredCredential(config, providerId);
  const local = localProviders.has(providerId);
  const keyless = TRUSTED_KEYLESS_OPENCODE_MODELS.has(model.trim());
  const ready = authenticated || local || keyless;
  return {
    ...status,
    authenticated,
    ready,
    unavailableReason: ready ? null : 'needs_auth',
    detail: keyless
      ? `OpenCode 2 model "${model.trim()}" supports keyless dispatch.`
      : local
      ? `OpenCode 2 provider "${providerId}" is configured for local dispatch.`
      : authenticated
        ? `OpenCode 2 provider "${providerId}" has credential evidence.`
        : `OpenCode 2 provider "${providerId}" has no credential evidence and is not configured for local dispatch.`,
    fix: ready
      ? 'No action needed.'
      : `Sign in to the OpenCode 2 provider "${providerId}" or configure that provider with a local baseURL.`,
  };
}

async function probeCodexAuth(binaryPath: string): Promise<boolean> {
  try {
    const probe = cliInvocation(binaryPath, ['login', 'status']);
    const { stdout, stderr } = await execFileAsync(probe.command, probe.args, {
      windowsHide: true,
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
  const binaryPath = scanAndLink('opencode2') ?? undefined;
  if (!binaryPath) {
    return nowStatus('opencode', 'opencode', {
      installed: false,
      authenticated: false,
      detail: 'OpenCode 2 CLI is not installed.',
      fix: 'Install `@opencode-ai/cli@next`, then sign in or configure a local provider.',
    });
  }

  const [credentialProviders, config, serviceVersion] = await Promise.all([
    opencodeCredentialProviders(os.homedir()),
    readOpencodeConfig(os.homedir()),
    probeOpencodeServiceVersion(binaryPath),
  ]);
  const authenticated = credentialProviders.size > 0;
  const localProviderConfigured = localProviderIds(config).size > 0;
  if (serviceVersion.state === 'version_skew') {
    return nowStatus('opencode', 'opencode', {
      installed: true,
      authenticated,
      ready: false,
      unavailableReason: 'needs_restart',
      detail: `OpenCode 2 CLI ${serviceVersion.cliVersion} does not match resident service ${serviceVersion.serviceVersion}.`,
      fix: 'Run `opencode2 service restart` so the resident service matches the installed CLI.',
      binaryPath,
    });
  }
  if (serviceVersion.state === 'incompatible') {
    return nowStatus('opencode', 'opencode', {
      installed: true,
      authenticated,
      ready: false,
      unavailableReason: 'needs_restart',
      detail: 'OpenCode 2 has a running resident service that did not return a compatible health response.',
      fix: 'Run `opencode2 service restart` before dispatching OpenCode 2.',
      binaryPath,
    });
  }
  const defaultModel = getRuntimeCapability('opencode').defaultModel;
  const defaultModelReady = Boolean(
    defaultModel && TRUSTED_KEYLESS_OPENCODE_MODELS.has(defaultModel),
  );
  return nowStatus('opencode', 'opencode', {
    installed: true,
    authenticated,
    ready: authenticated || defaultModelReady,
    detail: authenticated
      ? 'OpenCode 2 CLI is installed and has provider credential evidence.'
      : defaultModelReady
        ? `OpenCode 2 CLI is installed and its default model "${defaultModel}" supports keyless dispatch.`
      : localProviderConfigured
        ? 'OpenCode 2 CLI is installed and has a configured local provider; select one of that provider\'s models to dispatch.'
        : 'OpenCode 2 CLI is installed but has no credential evidence or configured local provider.',
    fix: authenticated || defaultModelReady
      ? 'No action needed.'
      : localProviderConfigured
        ? 'Select a model from the configured local provider, or run `opencode2 auth login`.'
        : 'Run `opencode2 auth login` or configure a provider with a local baseURL.',
    binaryPath,
  });
}

/**
 * Runs detectOpencode() at most once per OPENCODE_REFRESH_TTL_MS, coalescing any callers that
 * land inside an in-flight probe onto the same promise instead of spawning another one.
 */
function refreshOpencodeStatus(): Promise<RuntimeAuthStatus> {
  const now = Date.now();
  if (opencodeRefresh && now - opencodeRefresh.refreshedAt < OPENCODE_REFRESH_TTL_MS) {
    return opencodeRefresh.promise;
  }
  const promise = detectOpencode();
  opencodeRefresh = { promise, refreshedAt: now };
  promise.catch(() => {
    if (opencodeRefresh?.promise === promise) {
      opencodeRefresh = null;
    }
  });
  return promise;
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

async function detectDeepSeekHarness(): Promise<RuntimeAuthStatus> {
  const launch = await resolveDeepSeekHarnessLaunch().catch(() => null);
  if (!launch) {
    return nowStatus('deepseek-harness', 'deepseek-harness', {
      installed: false,
      authenticated: false,
      detail: deepSeekHarnessInstallGuidance(),
      fix: deepSeekHarnessInstallGuidance(),
    });
  }
  const provider = launch.provider;
  const authenticated = provider === 'deepseek-official'
    ? Boolean(process.env.DEEPSEEK_API_KEY?.trim())
    : Boolean(process.env.OPENROUTER_API_KEY?.trim());
  const credential = provider === 'deepseek-official' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY';
  return nowStatus('deepseek-harness', 'deepseek-harness', {
    installed: true,
    authenticated,
    detail: authenticated
      ? `DeepSeek Harness ACP is available from ${launch.source}${launch.version ? ` (${launch.version})` : ''} through ${provider}.`
      : `DeepSeek Harness ACP is available from ${launch.source}, but ${credential} is not set.`,
    fix: authenticated ? 'No action needed.' : `Set ${credential} before dispatching DeepSeek Harness.`,
    binaryPath: launch.command,
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

export function detectRuntimeAuthStatus(runtime: OrchestratorRuntime): Promise<RuntimeAuthStatus> {
  switch (runtime) {
    case 'codex': return detectCodex();
    case 'claude-code': return detectClaude();
    case 'gemini': return detectGemini();
    case 'opencode': return detectOpencode();
    case 'cursor': return detectCursor();
    case 'grok': return detectGrok();
    case 'pi': return detectPi();
    case 'prime-agent': return detectPrimeAgent();
    case 'deepseek-harness': return detectDeepSeekHarness();
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
  opencodeRefresh = null;
}

export async function getRuntimeAuthSnapshot(): Promise<RuntimeAuthSnapshot> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    const opencode = await refreshOpencodeStatus();
    cache.snapshot = {
      ...cache.snapshot,
      statuses: { ...cache.snapshot.statuses, opencode },
    };
    return cache.snapshot;
  }
  const entries = await Promise.all(listDispatchableRuntimes().map(async (runtime) => {
    const house = getRuntimeCapability(runtime).authHouse;
    if (!house) throw new Error(`Dispatchable runtime ${runtime} has no auth house.`);
    if (runtime === 'opencode') {
      return [house, await refreshOpencodeStatus()] as const;
    }
    return [house, await detectRuntimeAuthStatus(runtime)] as const;
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
    const available = Boolean(status?.installed && (status.ready ?? status.authenticated));
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

export async function assertRuntimeDispatchable(
  runtime: OrchestratorRuntime,
  model?: string | null,
  cwd?: string | null,
): Promise<void> {
  const snapshot = await getRuntimeAuthSnapshot();
  const availability = (await getDispatchableRuntimeAvailability(snapshot)).find((entry) => entry.id === runtime);
  const house = houseForRuntime(runtime);
  const status = house ? snapshot.statuses[house] : null;
  if (
    runtime === 'opencode'
    && status?.unavailableReason === 'needs_restart'
    && availability?.unavailableReason !== 'adapter_unavailable'
  ) {
    throw new DispatchPreflightError(status);
  }
  if (
    runtime === 'opencode'
    && model?.trim()
    && status?.installed
    && availability?.unavailableReason !== 'adapter_unavailable'
  ) {
    const modelStatus = await opencodeModelStatus(status, model, cwd);
    if (modelStatus.ready) return;
    throw new DispatchPreflightError(modelStatus);
  }
  if (availability?.available) return;

  throw new DispatchPreflightError(status ?? {
    house,
    runtime,
    installed: false,
    ready: false,
    authenticated: false,
    unavailableReason: availability?.unavailableReason ?? 'adapter_unavailable',
    detail: availability?.detail ?? `Runtime "${runtime}" is not dispatchable.`,
    fix: availability?.fix ?? 'Choose an available runtime.',
    checkedAt: Date.now(),
  });
}
