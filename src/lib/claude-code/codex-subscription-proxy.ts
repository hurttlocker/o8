import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { browserOpenInvocation, findLatestCodexOAuthUrl } from './codex-subscription-oauth';

const DEFAULT_PORT = 8317;
const START_TIMEOUT_MS = 12_000;

type ManagedState = {
  server: ChildProcess | null;
  serverStart: Promise<CodexSubscriptionProxyConnection> | null;
  login: ChildProcess | null;
};

const processState = globalThis as typeof globalThis & {
  __o8ClaudeCodeCodexProxy?: ManagedState;
};
const managed = processState.__o8ClaudeCodeCodexProxy ??= {
  server: null,
  serverStart: null,
  login: null,
};

export const CLAUDE_CODE_CODEX_DEFAULT_MODEL = 'gpt-5.6-sol';

export interface CodexSubscriptionProxyConnection {
  baseUrl: string;
  clientToken: string;
  models: string[];
}

export interface CodexSubscriptionProxyStatus {
  installed: boolean;
  authenticated: boolean;
  running: boolean;
  connecting: boolean;
  modelCount: number;
  error?: string;
}

function rootDir(): string {
  const configured = process.env.O8_CLIPROXYAPI_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(getDataDir(), 'cliproxy');
}

function authDir(): string {
  return path.join(rootDir(), 'codex-auth');
}

function configPath(): string {
  return path.join(rootDir(), 'config.yaml');
}

function tokenPath(): string {
  return path.join(rootDir(), 'client-token');
}

function logPath(kind: 'server' | 'login'): string {
  return path.join(rootDir(), `${kind}.log`);
}

function port(): number {
  const configured = Number.parseInt(process.env.O8_CLIPROXYAPI_PORT ?? '', 10);
  return Number.isInteger(configured) && configured >= 1024 && configured <= 65_535
    ? configured
    : DEFAULT_PORT;
}

function baseUrl(): string {
  return `http://127.0.0.1:${port()}`;
}

async function secureRoot(): Promise<void> {
  await mkdir(authDir(), { recursive: true, mode: 0o700 });
  await chmod(rootDir(), 0o700);
  await chmod(authDir(), 0o700);
}

async function writeSecureAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureClientToken(): Promise<string> {
  await secureRoot();
  const existing = await readFile(tokenPath(), 'utf8').catch(() => '');
  if (/^[a-f0-9]{64}$/i.test(existing.trim())) return existing.trim();
  const token = randomBytes(32).toString('hex');
  await writeSecureAtomic(tokenPath(), `${token}\n`);
  return token;
}

function renderConfig(clientToken: string): string {
  return [
    'host: "127.0.0.1"',
    `port: ${port()}`,
    `auth-dir: ${JSON.stringify(authDir())}`,
    'api-keys:',
    `  - ${JSON.stringify(clientToken)}`,
    'remote-management:',
    '  allow-remote: false',
    '  secret-key: ""',
    '  disable-control-panel: true',
    'debug: false',
    'logging-to-file: false',
    'usage-statistics-enabled: false',
    'request-retry: 0',
    'plugins:',
    '  enabled: false',
    '',
  ].join('\n');
}

async function ensureConfig(): Promise<{ clientToken: string; path: string }> {
  const clientToken = await ensureClientToken();
  const content = renderConfig(clientToken);
  const existing = await readFile(configPath(), 'utf8').catch(() => '');
  if (existing !== content) await writeSecureAtomic(configPath(), content);
  else await chmod(configPath(), 0o600);
  return { clientToken, path: configPath() };
}

async function resolveProxyBinary(): Promise<string | null> {
  try {
    return (await resolveCli({
      runtimeId: 'claude-code-codex-proxy',
      binaryName: 'cliproxyapi',
      envOverride: 'O8_CLIPROXYAPI_BIN',
      versionArgs: ['--help'],
    })).path;
  } catch (error) {
    if (error instanceof CliNotFoundError) return null;
    throw error;
  }
}

async function hasCodexAuth(): Promise<boolean> {
  const entries = await readdir(authDir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const credentialPath = path.join(authDir(), entry.name);
    await chmod(credentialPath, 0o600).catch(() => {});
    const raw = await readFile(credentialPath, 'utf8').catch(() => '');
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.type === 'codex') return true;
    } catch {
      // A malformed or partially written credential is not usable authentication.
    }
  }
  return false;
}

async function probe(clientToken: string): Promise<CodexSubscriptionProxyConnection | null> {
  try {
    const response = await fetch(`${baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${clientToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(1_500),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .flatMap((model) => typeof model.id === 'string' && model.id.trim() ? [model.id.trim()] : []);
    return { baseUrl: baseUrl(), clientToken, models };
  } catch {
    return null;
  }
}

function openLog(kind: 'server' | 'login'): number {
  return openSync(logPath(kind), kind === 'login' ? 'w' : 'a', 0o600);
}

async function openCodexLoginInBrowser(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const loginUrl = findLatestCodexOAuthUrl(await readFile(logPath('login'), 'utf8').catch(() => ''));
    if (loginUrl) {
      const invocation = browserOpenInvocation(loginUrl);
      if (!invocation) return;
      const opener = spawn(invocation.command, invocation.args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      opener.once('error', () => {});
      opener.unref();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function spawnProxy(binary: string, args: string[], kind: 'server' | 'login'): ChildProcess {
  const log = openLog(kind);
  const env = { ...process.env };
  delete env.BROWSER;
  try {
    const child = spawn(binary, args, {
      cwd: rootDir(),
      env,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

async function waitUntilReady(clientToken: string): Promise<CodexSubscriptionProxyConnection> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const connection = await probe(clientToken);
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The Codex subscription proxy did not become ready on localhost. Check Settings > Models and the local proxy log.');
}

export async function ensureCodexSubscriptionProxyReady(): Promise<CodexSubscriptionProxyConnection> {
  if (managed.serverStart) return managed.serverStart;
  managed.serverStart = (async () => {
    const binary = await resolveProxyBinary();
    if (!binary) throw new Error('CLIProxyAPI is not installed. Install it with Homebrew before using the Codex subscription carrier.');
    if (!await hasCodexAuth()) throw new Error('The Codex subscription carrier is not connected. Connect it once in Settings > Models.');
    const config = await ensureConfig();
    const existing = await probe(config.clientToken);
    if (existing) return existing;
    const child = spawnProxy(binary, ['-config', config.path], 'server');
    managed.server = child;
    child.once('exit', () => {
      if (managed.server === child) managed.server = null;
    });
    child.once('error', () => {
      if (managed.server === child) managed.server = null;
    });
    return waitUntilReady(config.clientToken);
  })();
  try {
    return await managed.serverStart;
  } finally {
    managed.serverStart = null;
  }
}

export async function startCodexSubscriptionProxyLogin(): Promise<CodexSubscriptionProxyStatus> {
  const binary = await resolveProxyBinary();
  if (!binary) throw new Error('CLIProxyAPI is not installed. Run `brew install cliproxyapi`, then connect again.');
  if (await hasCodexAuth()) return getCodexSubscriptionProxyStatus();
  if (!managed.login || managed.login.exitCode !== null) {
    const config = await ensureConfig();
    const child = spawnProxy(binary, ['-config', config.path, '-codex-login', '-no-browser'], 'login');
    managed.login = child;
    void openCodexLoginInBrowser(child).catch(() => {});
    child.once('exit', () => {
      if (managed.login === child) managed.login = null;
      void hasCodexAuth();
    });
    child.once('error', () => {
      if (managed.login === child) managed.login = null;
    });
  }
  return getCodexSubscriptionProxyStatus();
}

export async function getCodexSubscriptionProxyStatus(): Promise<CodexSubscriptionProxyStatus> {
  const installed = Boolean(await resolveProxyBinary());
  const authenticated = await hasCodexAuth();
  const connecting = Boolean(managed.login && managed.login.exitCode === null);
  if (!installed || !authenticated) {
    return { installed, authenticated, running: false, connecting, modelCount: 0 };
  }
  const clientToken = await readFile(tokenPath(), 'utf8').catch(() => '');
  const connection = /^[a-f0-9]{64}$/i.test(clientToken.trim())
    ? await probe(clientToken.trim())
    : null;
  return {
    installed,
    authenticated,
    running: Boolean(connection),
    connecting,
    modelCount: connection?.models.length ?? 0,
  };
}

export async function ensureCodexSubscriptionClaudeConfigDir(sessionDir: string): Promise<string> {
  return ensureClaudeCodeWorkerConfigDir(sessionDir);
}

export async function ensureClaudeCodeWorkerConfigDir(sessionDir: string): Promise<string> {
  const configDir = path.join(sessionDir, 'claude-code-worker-config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  await rm(path.join(configDir, 'skills'), { recursive: true, force: true });
  return configDir;
}
