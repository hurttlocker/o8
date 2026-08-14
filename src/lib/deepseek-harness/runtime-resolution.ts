import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { scanAndLink } from '@/lib/runtimes/shared/cli-locate';

const CACHE_TTL_MS = 60_000;
const PREVIEW_VERSION = '0.1.0-rc.6';

type HarnessProvider = 'deepseek-official' | 'openrouter';

export interface DeepSeekHarnessLaunch {
  command: string;
  args: string[];
  configPath?: string;
  source: 'env' | 'path';
  version?: string;
  provider: HarnessProvider;
  model: string;
}

export class DeepSeekHarnessUnavailableError extends Error {
  readonly code = 'deepseek_harness_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'DeepSeekHarnessUnavailableError';
  }
}

const cache = new Map<string, { launch: DeepSeekHarnessLaunch; checkedAt: number }>();

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

function providerRoute(): HarnessProvider {
  const override = process.env.O8_DEEPSEEK_HARNESS_PROVIDER?.trim();
  if (override === 'deepseek-official' || override === 'openrouter') return override;
  if (override) {
    throw new DeepSeekHarnessUnavailableError(
      'O8_DEEPSEEK_HARNESS_PROVIDER must be "deepseek-official" or "openrouter".',
    );
  }
  if (process.env.OPENROUTER_API_KEY?.trim()) return 'openrouter';
  return process.env.DEEPSEEK_API_KEY?.trim() ? 'deepseek-official' : 'openrouter';
}

function providerModel(provider: HarnessProvider, requested?: string): string {
  const model = requested?.trim() || 'deepseek-v4-pro';
  if (!/^[a-zA-Z0-9._/:+-]+$/.test(model)) {
    throw new DeepSeekHarnessUnavailableError('DeepSeek Harness model ids may contain only letters, numbers, ., _, /, :, +, and -.');
  }
  if (provider === 'openrouter') return model.includes('/') ? model : `deepseek/${model}`;
  return model.startsWith('deepseek/') ? model.slice('deepseek/'.length) : model;
}

function acpConfig(provider: HarnessProvider, model: string): string {
  const llm = provider === 'openrouter'
    ? `- id: llm-openrouter
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        models:
          - id: ${model}`
    : `- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max
    models:
      - id: ${model}`;
  return `${llm}

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.cwd()

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    timeoutMs: 60000

- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask

- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()

- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: ${provider}
    model: ${model}
    persistenceRoot: !!js "process.env.DSH_SNAPSHOT_SESSIONS_ROOT ?? './.sessions'"
    persistenceCompression: none
    workspaceContext:
      maxBytes: 65536
    persona: |
      You are a coding assistant powered by the {{model}} model. Your working directory is {{cwd}}.
      Verify changes by running the relevant tests. Keep answers brief and factual.
`;
}

async function ensureAcpConfig(provider: HarnessProvider, model: string): Promise<string> {
  const dir = path.join(getDataDir(), 'runtime-config');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const configPath = path.join(dir, `deepseek-harness-${provider}-${safeModel}.cordis.yml`);
  await writeFile(configPath, acpConfig(provider, model), { encoding: 'utf8', mode: 0o600 });
  await chmod(configPath, 0o600);
  return configPath;
}

function isOfficialAcpCommand(command: string): boolean {
  return path.basename(command).replace(/\.(cmd|exe)$/i, '') === 'dsh-acp-demo';
}

export function deepSeekHarnessInstallGuidance(): string {
  return `Install the official preview ACP packages with \`npm install -g @deepseek-ai/dsh-acp-demo@${PREVIEW_VERSION} @deepseek-ai/dsh-llm-pi-ai@${PREVIEW_VERSION} @deepseek-ai/dsh-sandbox-local@${PREVIEW_VERSION} @deepseek-ai/dsh-sandbox-policy@${PREVIEW_VERSION} @deepseek-ai/dsh-subprocess-local@${PREVIEW_VERSION} @deepseek-ai/dsh-bash-sandbox@${PREVIEW_VERSION} @deepseek-ai/dsh-user-approval@${PREVIEW_VERSION} @deepseek-ai/dsh-fs-sandbox@${PREVIEW_VERSION} @deepseek-ai/dsh-fs-observation-policy@${PREVIEW_VERSION} @deepseek-ai/dsh-tool-fs@${PREVIEW_VERSION}\`, then set OPENROUTER_API_KEY. A direct DeepSeek route instead requires @deepseek-ai/dsh-llm-deepseek@${PREVIEW_VERSION} and DEEPSEEK_API_KEY.`;
}

export async function resolveDeepSeekHarnessLaunch(options: {
  fresh?: boolean;
  model?: string;
} = {}): Promise<DeepSeekHarnessLaunch> {
  const provider = providerRoute();
  const model = providerModel(provider, options.model);
  const key = `${provider}:${model}`;
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached.launch;
  const override = process.env.O8_DEEPSEEK_HARNESS_BIN?.trim();
  const command = override || scanAndLink('dsh-acp-demo');
  if (!command) throw new DeepSeekHarnessUnavailableError(deepSeekHarnessInstallGuidance());
  const args = parseArgsEnv();
  let configPath = process.env.O8_DEEPSEEK_HARNESS_CONFIG?.trim() || undefined;
  if (!configPath && isOfficialAcpCommand(command)) configPath = await ensureAcpConfig(provider, model);
  if (configPath && !args.some((arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config='))) {
    args.push('--config', configPath);
  }
  const launch: DeepSeekHarnessLaunch = {
    command,
    args,
    configPath,
    source: override ? 'env' : 'path',
    version: isOfficialAcpCommand(command) ? PREVIEW_VERSION : undefined,
    provider,
    model,
  };
  cache.set(key, { launch, checkedAt: Date.now() });
  return launch;
}

export function invalidateDeepSeekHarnessLaunchCache(): void {
  cache.clear();
}
