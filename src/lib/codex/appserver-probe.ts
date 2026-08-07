import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { scanForBinary } from '../runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 2_500;
const INITIALIZE_REQUEST_ID = 'o8-codex-voice-probe';
export const CODEX_REALTIME_METHODS = [
  'thread/realtime/start',
  'thread/realtime/appendAudio',
  'thread/realtime/appendText',
  'thread/realtime/appendSpeech',
  'thread/realtime/stop',
] as const;

export type CodexVoiceAuthMode = 'chatgpt_oauth' | 'api_key' | 'none' | 'unknown';
export type CodexAppServerTransport = 'stdio' | 'unix' | 'websocket';
export type CodexRealtimeMethod = (typeof CODEX_REALTIME_METHODS)[number];

export interface CodexVoiceCapability {
  checkedAt: number;
  capable: boolean;
  whyNot: string | null;
  installation: {
    installed: boolean;
    binaryPath: string | null;
    version: string | null;
    whyNot: string | null;
  };
  appServer: {
    reachable: boolean;
    transports: CodexAppServerTransport[];
    supportedTransports: CodexAppServerTransport[];
    realtimeMethods: CodexRealtimeMethod[];
    missingRealtimeMethods: CodexRealtimeMethod[];
    whyNot: string | null;
  };
  auth: {
    mode: CodexVoiceAuthMode;
    chatgptOAuth: boolean;
    authPath: string;
    whyNot: string | null;
  };
  realtime: {
    enabled: boolean;
    featureEnabled: boolean;
    realtimeSectionPresent: boolean;
    websocketModeEnabled: boolean;
    configPath: string;
    whyNot: string | null;
  };
}

export interface CodexVoiceProbeOptions {
  /** Injected by callers that already resolved Codex. null means known missing. */
  binaryPath?: string | null;
  /** Reuse a version already read by the caller. */
  version?: string | null;
  home?: string;
  codexHome?: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  /** Harnesses may skip a live stdio initialize while inspecting real user state. */
  initializeAppServer?: boolean;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RealtimeConfigState {
  featureEnabled: boolean;
  realtimeSectionPresent: boolean;
  websocketModeEnabled: boolean;
}

interface StdioCapabilityProbe {
  reachable: boolean;
  realtimeMethods: CodexRealtimeMethod[];
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexBinary(
  options: CodexVoiceProbeOptions,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string | null> {
  if (options.binaryPath === null) return null;
  if (options.binaryPath && await isExecutable(options.binaryPath)) return options.binaryPath;

  for (const key of ['O8_CODEX_BIN', 'CODEX_BIN', 'CODEX_CLI_PATH']) {
    const candidate = env[key]?.trim();
    if (candidate && await isExecutable(candidate)) return candidate;
  }

  const scanned = scanForBinary('codex', home);
  if (scanned && await isExecutable(scanned)) return scanned;

  const bundledCandidates = [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ];
  for (const candidate of bundledCandidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function runCommand(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const probe = cliInvocation(binaryPath, args);
    const { stdout, stderr } = await execFileAsync(probe.command, probe.args, {
      windowsHide: true,
      env,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      encoding: 'utf-8',
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: detail.stdout ?? '',
      stderr: detail.stderr ?? detail.message ?? '',
    };
  }
}

function parseVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1] ?? null;
}

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function stripTomlComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (char === '"' && !singleQuoted && line[index - 1] !== '\\') doubleQuoted = !doubleQuoted;
    if (char === '#' && !singleQuoted && !doubleQuoted) return line.slice(0, index);
  }
  return line;
}

function unquoteTomlValue(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseRealtimeConfig(content: string): RealtimeConfigState {
  let section = '';
  let featureEnabled = false;
  let realtimeSectionPresent = false;
  let websocketModeEnabled = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]?.trim().toLowerCase() ?? '';
      if (section === 'realtime') realtimeSectionPresent = true;
      continue;
    }

    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const rawValue = line.slice(separator + 1).trim();
    const value = unquoteTomlValue(rawValue).toLowerCase();

    if (section === 'features' && key === 'realtime_conversation') {
      featureEnabled = parseBoolean(rawValue);
    }
    if (
      (key === 'experimental_realtime_ws_mode' && (parseBoolean(rawValue) || value === 'websocket'))
      || (section === 'realtime' && key === 'transport' && ['websocket', 'ws'].includes(value))
    ) {
      websocketModeEnabled = true;
    }
  }

  return {
    featureEnabled,
    realtimeSectionPresent,
    websocketModeEnabled,
  };
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function detectAuthMode(
  authPath: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexVoiceAuthMode> {
  const auth = await readJsonRecord(authPath);
  const rawMode = typeof auth?.auth_mode === 'string' ? auth.auth_mode.toLowerCase() : '';
  const tokens = auth?.tokens && typeof auth.tokens === 'object'
    ? auth.tokens as Record<string, unknown>
    : null;
  const hasOauthTokens = Boolean(tokens?.access_token || tokens?.refresh_token || tokens?.id_token);
  const hasApiKey = Boolean(
    env.OPENAI_API_KEY?.trim()
    || env.CODEX_API_KEY?.trim()
    || (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()),
  );

  if (rawMode === 'chatgpt' || rawMode.includes('oauth')) return 'chatgpt_oauth';
  if (rawMode.includes('api')) return 'api_key';
  if (hasOauthTokens) return 'chatgpt_oauth';
  if (hasApiKey) return 'api_key';
  if (!auth) return hasApiKey ? 'api_key' : 'none';
  return 'unknown';
}

function parseSupportedTransports(help: string): CodexAppServerTransport[] {
  const transports: CodexAppServerTransport[] = [];
  if (help.includes('stdio://') || help.includes('--stdio')) transports.push('stdio');
  if (help.includes('unix://')) transports.push('unix');
  if (help.includes('ws://')) transports.push('websocket');
  return transports;
}

async function probeStdioCapabilities(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<StdioCapabilityProbe> {
  return new Promise((resolve) => {
    const launch = cliInvocation(binaryPath, ['app-server', '--stdio']);
    const child = spawn(launch.command, launch.args, {
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    let reachable = false;
    let stdout = '';
    const methodByRequestId = new Map(
      CODEX_REALTIME_METHODS.map((method, index) => [
        `${INITIALIZE_REQUEST_ID}:${index + 1}`,
        method,
      ]),
    );
    const realtimeMethods = new Set<CodexRealtimeMethod>();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve({ reachable, realtimeMethods: [...realtimeMethods] });
    };
    const timer = setTimeout(finish, timeoutMs);

    child.once('error', finish);
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as {
            id?: unknown;
            result?: unknown;
            error?: { code?: unknown };
          };
          if (message.id === INITIALIZE_REQUEST_ID) {
            reachable = Boolean(message.result) && !message.error;
            if (!reachable) {
              finish();
              return;
            }
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
            for (const [id, method] of methodByRequestId) {
              child.stdin.write(`${JSON.stringify({ id, method, params: {} })}\n`);
            }
            continue;
          }
          const method = typeof message.id === 'string'
            ? methodByRequestId.get(message.id)
            : undefined;
          if (!method) continue;
          methodByRequestId.delete(message.id as string);
          if (!message.error || message.error.code !== -32601) {
            realtimeMethods.add(method);
          }
          if (methodByRequestId.size === 0) {
            finish();
            return;
          }
        } catch {
          // Ignore non-protocol diagnostics on stdout and wait for the response.
        }
      }
    });
    child.once('exit', finish);
    child.stdin.on('error', finish);
    child.stdin.write(`${JSON.stringify({
      id: INITIALIZE_REQUEST_ID,
      method: 'initialize',
      params: {
        clientInfo: { name: 'o8-codex-voice-probe', version: '1' },
        capabilities: { experimentalApi: true },
      },
    })}\n`);
  });
}

function parseEffectiveRealtimeFeature(output: string): boolean | null {
  const line = output.split(/\r?\n/).find((candidate) => (
    candidate.trim().startsWith('realtime_conversation')
  ));
  if (!line) return null;
  const match = line.match(/\b(true|false)\s*$/i);
  return match ? match[1]?.toLowerCase() === 'true' : null;
}

export async function probeCodexVoiceCapability(
  options: CodexVoiceProbeOptions = {},
): Promise<CodexVoiceCapability> {
  const home = options.home ?? os.homedir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  const codexHome = options.codexHome ?? env.CODEX_HOME?.trim() ?? path.join(home, '.codex');
  env.CODEX_HOME = codexHome;
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const binaryPath = await resolveCodexBinary(options, env, home);

  const installationWhyNot = binaryPath
    ? null
    : 'Codex app/CLI is not installed. Install Codex before using Connected Voice.';
  let version = options.version ? (parseVersion(options.version) ?? options.version) : null;
  const versionProbe = binaryPath && !version
    ? runCommand(binaryPath, ['--version'], env, timeoutMs)
    : Promise.resolve<CommandResult | null>(null);
  const appServerProbe = binaryPath
    ? Promise.all([
      runCommand(binaryPath, ['app-server', '--help'], env, timeoutMs),
      runCommand(binaryPath, ['app-server', 'daemon', 'version'], env, timeoutMs),
      options.initializeAppServer === false
        ? Promise.resolve<StdioCapabilityProbe>({ reachable: false, realtimeMethods: [] })
        : probeStdioCapabilities(binaryPath, env, timeoutMs),
    ])
    : Promise.resolve<[
      CommandResult,
      CommandResult,
      StdioCapabilityProbe,
    ] | null>(null);
  const featureProbe = binaryPath
    ? runCommand(binaryPath, ['features', 'list'], env, timeoutMs)
    : Promise.resolve<CommandResult | null>(null);
  const authModeProbe = detectAuthMode(authPath, env);
  const configContentProbe = readFile(configPath, 'utf-8').catch(() => '');

  const versionResult = await versionProbe;
  if (versionResult) {
    version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  }

  let appServerReachable = false;
  let transports: CodexAppServerTransport[] = [];
  let supportedTransports: CodexAppServerTransport[] = [];
  let realtimeMethods: CodexRealtimeMethod[] = [];
  const appServerResult = await appServerProbe;
  if (appServerResult) {
    const [helpResult, daemonResult, stdioCapability] = appServerResult;
    supportedTransports = parseSupportedTransports(`${helpResult.stdout}\n${helpResult.stderr}`);
    realtimeMethods = stdioCapability.realtimeMethods;
    if (stdioCapability.reachable) transports.push('stdio');
    if (daemonResult.ok) transports.push('unix');
    transports = [...new Set(transports)];
    appServerReachable = transports.length > 0;
  }
  const appServerWhyNot = appServerReachable
    ? null
    : binaryPath
      ? options.initializeAppServer === false
        ? 'Live stdio reachability was not requested and no managed Unix daemon was reachable.'
        : 'Codex is installed, but its app-server did not answer over stdio and no managed Unix daemon was reachable.'
      : 'Codex is not installed, so its app-server cannot be probed.';

  const authMode = await authModeProbe;
  const authWhyNot = authMode === 'chatgpt_oauth'
    ? null
    : authMode === 'api_key'
      ? 'Codex is using API-key auth. Connected Voice requires ChatGPT OAuth; text fallback remains available.'
      : authMode === 'none'
        ? 'Codex is not signed in. Run `codex login` and choose ChatGPT OAuth.'
        : 'Codex auth exists, but o8 could not confirm ChatGPT OAuth.';

  const configContent = await configContentProbe;
  const configState = parseRealtimeConfig(configContent);
  let effectiveFeature = configState.featureEnabled;
  const featureResult = await featureProbe;
  if (featureResult) {
    const activeFeature = parseEffectiveRealtimeFeature(`${featureResult.stdout}\n${featureResult.stderr}`);
    if (activeFeature !== null) effectiveFeature = activeFeature;
  }
  const missingRealtimeMethods = CODEX_REALTIME_METHODS.filter(
    (method) => !realtimeMethods.includes(method),
  );
  const realtimeEnabled = effectiveFeature
    && configState.realtimeSectionPresent
    && configState.websocketModeEnabled
    && missingRealtimeMethods.length === 0;
  const realtimeWhyNot = !effectiveFeature
    ? 'Codex realtime conversation is disabled in the active config. Enable it only in an isolated spike config.'
    : !configState.realtimeSectionPresent
      ? 'Codex realtime config is missing its [realtime] section.'
      : !configState.websocketModeEnabled
        ? 'Codex realtime websocket mode is disabled in the active config.'
        : missingRealtimeMethods.length > 0
          ? `Codex app-server is missing realtime methods: ${missingRealtimeMethods.join(', ')}.`
          : null;

  const whyNot = installationWhyNot ?? appServerWhyNot ?? authWhyNot ?? realtimeWhyNot;
  return {
    checkedAt: Date.now(),
    capable: whyNot === null,
    whyNot,
    installation: {
      installed: binaryPath !== null,
      binaryPath,
      version,
      whyNot: installationWhyNot,
    },
    appServer: {
      reachable: appServerReachable,
      transports,
      supportedTransports,
      realtimeMethods,
      missingRealtimeMethods,
      whyNot: appServerWhyNot,
    },
    auth: {
      mode: authMode,
      chatgptOAuth: authMode === 'chatgpt_oauth',
      authPath,
      whyNot: authWhyNot,
    },
    realtime: {
      enabled: realtimeEnabled,
      featureEnabled: effectiveFeature,
      realtimeSectionPresent: configState.realtimeSectionPresent,
      websocketModeEnabled: configState.websocketModeEnabled,
      configPath,
      whyNot: realtimeWhyNot,
    },
  };
}
