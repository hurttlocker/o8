import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

import { scanAndLink } from '@/lib/runtimes/shared/cli-locate';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_500;
const CACHE_TTL_MS = 60_000;

export interface DeepSeekHarnessLaunch {
  command: string;
  args: string[];
  configPath?: string;
  source: 'env' | 'path' | 'python-wheel';
  version?: string;
}

export class DeepSeekHarnessUnavailableError extends Error {
  readonly code = 'deepseek_harness_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekHarnessUnavailableError';
  }
}

let cache: { launch: DeepSeekHarnessLaunch; checkedAt: number } | null = null;

function parseArgsEnv(): string[] {
  const raw = process.env.O8_DEEPSEEK_HARNESS_ARGS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeepSeekHarnessUnavailableError(
      'O8_DEEPSEEK_HARNESS_ARGS must be a JSON array of strings.',
    );
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new DeepSeekHarnessUnavailableError(
      'O8_DEEPSEEK_HARNESS_ARGS must be a JSON array of strings.',
    );
  }
  return parsed;
}

function explicitLaunch(): DeepSeekHarnessLaunch | null {
  const override = process.env.O8_DEEPSEEK_HARNESS_BIN?.trim();
  const command = override || scanAndLink('dsh-jsonrpc-agent');
  if (!command) return null;
  const configPath = process.env.O8_DEEPSEEK_HARNESS_CONFIG?.trim()
    || process.env.DSH_CORDIS_CONFIG?.trim()
    || undefined;
  return {
    command,
    args: parseArgsEnv(),
    configPath,
    source: override ? 'env' : 'path',
  };
}

async function pythonWheelLaunch(): Promise<DeepSeekHarnessLaunch | null> {
  const requestedPython = process.env.O8_DEEPSEEK_HARNESS_PYTHON?.trim();
  const python = requestedPython || scanAndLink('python3') || scanAndLink('python');
  if (!python) return null;
  const script = [
    'import importlib.metadata as m, json',
    'from deepseek_harness_runtime import resolve_bundled_launch_args, bundled_default_config_path',
    'print(json.dumps({"args": list(resolve_bundled_launch_args()), "config": str(bundled_default_config_path()), "version": m.version("deepseek-harness-runtime-bin")}))',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(python, ['-c', script], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      env: process.env,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as { args?: unknown; config?: unknown; version?: unknown };
    if (!Array.isArray(parsed.args)
      || parsed.args.length === 0
      || parsed.args.some((value) => typeof value !== 'string')
      || typeof parsed.config !== 'string'
      || !parsed.config.trim()) {
      return null;
    }
    const [command, ...args] = parsed.args;
    if (!command || !existsSync(command) || !existsSync(parsed.config)) return null;
    return {
      command,
      args,
      configPath: parsed.config,
      source: 'python-wheel',
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
    };
  } catch {
    return null;
  }
}

export function deepSeekHarnessInstallGuidance(): string {
  if (process.platform === 'darwin' && os.arch() === 'x64') {
    return 'The current official runtime wheel does not support Intel macOS. Set O8_DEEPSEEK_HARNESS_BIN to a compatible official JSON-RPC carrier, or run o8 on Apple silicon or Linux.';
  }
  return 'Install the preview runtime with `python -m pip install --pre deepseek-harness-sdk`, then set DEEPSEEK_API_KEY. You can also point O8_DEEPSEEK_HARNESS_BIN at an official JSON-RPC carrier.';
}

export async function resolveDeepSeekHarnessLaunch(options: { fresh?: boolean } = {}): Promise<DeepSeekHarnessLaunch> {
  if (!options.fresh && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) return cache.launch;
  const launch = explicitLaunch() ?? await pythonWheelLaunch();
  if (!launch) throw new DeepSeekHarnessUnavailableError(deepSeekHarnessInstallGuidance());
  cache = { launch, checkedAt: Date.now() };
  return launch;
}

export function invalidateDeepSeekHarnessLaunchCache(): void {
  cache = null;
}
