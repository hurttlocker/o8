import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  ORCHESTRATOR_RUNTIME_IDS,
  getRuntimeCapability,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { cachedAcpModels, probeAcpModels } from '@/lib/orchestrator/acp-model-probe';
import { resolveAcpLaunch } from '@/lib/lane/orchestrator-backends/acp';
import { getAllRuntimes } from '@/lib/runtimes';
import { detectRuntimeAuthStatus } from '@/lib/runtimes/shared/auth-detect';
import { scanAndLink } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { listOwnedSessionLifecycles } from '@/lib/runtimes/shared/owned-session-lifecycle';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 5_000;
const MODEL_CATALOGUE_TIMEOUT_MS = 5_000;
const INTERNAL_CONTRACT_URL = 'https://github.com/hurttlocker/o8/blob/main/docs/internals/runtime-adapter-contract.md';

export type RuntimeEvidenceConfidence = 'verified' | 'reported' | 'unknown';
export type RuntimeEvidenceFreshness = 'fresh' | 'stale' | 'missing';
export type RuntimeBillingMode = 'subscription-capacity' | 'api-token' | 'local-inference' | 'unknown';
export type RuntimeModelSelectionMode = 'provider-native' | 'live-catalog' | 'configured-provider' | 'fixed' | 'unknown';
export type RuntimeTransport =
  | 'acp'
  | 'discovery-only'
  | 'headless-json-schema'
  | 'interactive-terminal'
  | 'jsonl'
  | 'ndjson'
  | 'stdio-json-rpc'
  | 'stream-json'
  | 'text';

export interface RuntimeCarrierEvidence {
  os: 'darwin' | 'linux' | 'win32' | 'unknown';
  architectures: string[];
  support: 'supported' | 'unsupported' | 'unknown';
  sourceId: string;
  note?: string;
}

export interface RuntimeEvidenceSource {
  id: string;
  label: string;
  url: string;
  observedAt: string;
  maxAgeDays: number;
  confidence: RuntimeEvidenceConfidence;
  scope: 'o8-contract' | 'runtime-upstream' | 'provider-official' | 'broker-live-catalog';
}

export interface RuntimePriceEvidence {
  providerId: string;
  modelId: string;
  billingMode: 'api-token';
  unit: 'usd-per-million-tokens';
  inputUsd: number;
  cachedInputUsd: number | null;
  outputUsd: number;
  sourceId: string;
  note?: string;
}

export interface RuntimeEvidenceDefinition {
  carriers: RuntimeCarrierEvidence[];
  transports: RuntimeTransport[];
  modelSelection: RuntimeModelSelectionMode;
  advertisedModelIds: string[];
  billingModes: RuntimeBillingMode[];
  pricing: RuntimePriceEvidence[];
  sources: RuntimeEvidenceSource[];
}

export interface RuntimeEvidenceTarget {
  providerId: string;
  modelId: string;
  runtimeModelId: string;
  available: boolean | null;
}

export interface RuntimeEvidenceEntry extends RuntimeEvidenceDefinition {
  runtimeId: OrchestratorRuntime;
  label: string;
  binaryName: string;
  dispatchable: boolean;
  installed: boolean;
  ready: boolean;
  installedVersion: string | null;
  checkedAt: string;
  localCarrier: {
    os: NodeJS.Platform;
    architecture: string;
    installed: boolean;
    ready: boolean;
  };
  capabilities: {
    discover: boolean;
    launch: boolean;
    resume: boolean;
    interrupt: boolean;
    transcript: boolean;
    review: boolean;
    telemetry: boolean;
    archive: boolean;
  };
  defaultModel: string | null;
  freshness: RuntimeEvidenceFreshness;
  modelCatalogue: {
    source: 'cache' | 'probe' | null;
    observedAt: string | null;
    total: number | null;
    targets: RuntimeEvidenceTarget[];
    error: string | null;
  } | null;
}

export interface RuntimeEvidenceSnapshot {
  schema: 'o8/runtime-evidence/v1';
  generatedAt: string;
  runtimes: RuntimeEvidenceEntry[];
}

const internalSource = (runtime: OrchestratorRuntime): RuntimeEvidenceSource => ({
  id: `o8-contract-${runtime}`,
  label: 'o8 runtime adapter contract',
  url: INTERNAL_CONTRACT_URL,
  observedAt: '2026-08-14',
  maxAgeDays: 365,
  confidence: 'verified',
  scope: 'o8-contract',
});

const unknownEvidence = (
  runtime: OrchestratorRuntime,
  transports: RuntimeTransport[],
  modelSelection: RuntimeModelSelectionMode = 'unknown',
): RuntimeEvidenceDefinition => ({
  carriers: [{
    os: 'unknown',
    architectures: [],
    support: 'unknown',
    sourceId: `o8-contract-${runtime}`,
  }],
  transports,
  modelSelection,
  advertisedModelIds: [],
  billingModes: ['unknown'],
  pricing: [],
  sources: [internalSource(runtime)],
});

const OPENCODE_TARGETS = [
  { providerId: 'x-ai', modelId: 'grok-4.6', runtimeModelId: 'openrouter/x-ai/grok-4.6' },
  { providerId: 'deepseek', modelId: 'deepseek-v4-pro-0813', runtimeModelId: 'openrouter/deepseek/deepseek-v4-pro-0813' },
  { providerId: 'google', modelId: 'gemini-3.7-flash', runtimeModelId: 'openrouter/google/gemini-3.7-flash' },
] as const;

// Specialized owned stores predate the declarative lifecycle registry but are
// still archived through archiveOwnedRuntimeSession's built-in dispatch.
const BUILT_IN_ARCHIVE_RUNTIMES = new Set<OrchestratorRuntime>([
  'codex',
  'claude-code',
  'gemini',
  'opencode',
  'cursor',
  'grok',
  'pi',
  'prime-agent',
  'deepseek-harness',
]);

export const RUNTIME_EVIDENCE_DEFINITIONS = {
  codex: unknownEvidence('codex', ['jsonl'], 'provider-native'),
  'claude-code': unknownEvidence('claude-code', ['stream-json'], 'provider-native'),
  gemini: {
    ...unknownEvidence('gemini', ['stream-json'], 'provider-native'),
    advertisedModelIds: ['gemini-3.6-flash'],
    sources: [
      internalSource('gemini'),
      {
        id: 'gemini-models',
        label: 'Gemini API models',
        url: 'https://ai.google.dev/gemini-api/docs/models',
        observedAt: '2026-08-14',
        maxAgeDays: 30,
        confidence: 'verified',
        scope: 'provider-official',
      },
    ],
  },
  antigravity: unknownEvidence('antigravity', ['discovery-only'], 'provider-native'),
  magnitude: unknownEvidence('magnitude', ['interactive-terminal']),
  opencode: {
    carriers: [{
      os: 'unknown',
      architectures: [],
      support: 'unknown',
      sourceId: 'o8-contract-opencode',
    }],
    transports: ['acp', 'jsonl'],
    modelSelection: 'live-catalog',
    advertisedModelIds: OPENCODE_TARGETS.map((target) => target.runtimeModelId),
    billingModes: ['api-token', 'subscription-capacity', 'local-inference'],
    pricing: [
      {
        providerId: 'x-ai',
        modelId: 'grok-4.6',
        billingMode: 'api-token',
        unit: 'usd-per-million-tokens',
        inputUsd: 2,
        cachedInputUsd: 0.5,
        outputUsd: 6,
        sourceId: 'openrouter-live-models',
        note: 'OpenRouter price; prompts above 200k tokens use the catalogued higher tier.',
      },
      {
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro-0813',
        billingMode: 'api-token',
        unit: 'usd-per-million-tokens',
        inputUsd: 0.435,
        cachedInputUsd: 0.003625,
        outputUsd: 0.87,
        sourceId: 'openrouter-live-models',
      },
      {
        providerId: 'google',
        modelId: 'gemini-3.7-flash',
        billingMode: 'api-token',
        unit: 'usd-per-million-tokens',
        inputUsd: 0.375,
        cachedInputUsd: 0.0375,
        outputUsd: 1.875,
        sourceId: 'openrouter-live-models',
      },
    ],
    sources: [
      internalSource('opencode'),
      {
        id: 'opencode-v2-models',
        label: 'OpenCode 2 model contract',
        url: 'https://opencode.ai/v2/docs/models',
        observedAt: '2026-08-14',
        maxAgeDays: 30,
        confidence: 'verified',
        scope: 'runtime-upstream',
      },
      {
        id: 'openrouter-live-models',
        label: 'OpenRouter live model catalog',
        url: 'https://openrouter.ai/api/v1/models',
        observedAt: '2026-08-14',
        maxAgeDays: 7,
        confidence: 'verified',
        scope: 'broker-live-catalog',
      },
    ],
  },
  'copilot-cli': {
    ...unknownEvidence('copilot-cli', ['jsonl'], 'provider-native'),
    billingModes: ['subscription-capacity', 'api-token', 'local-inference'],
    sources: [
      internalSource('copilot-cli'),
      {
        id: 'copilot-cli-programmatic-contract',
        label: 'Copilot CLI programmatic reference',
        url: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference',
        observedAt: '2026-09-01',
        maxAgeDays: 30,
        confidence: 'verified',
        scope: 'runtime-upstream',
      },
    ],
  },
  crush: {
    ...unknownEvidence('crush', ['text'], 'configured-provider'),
    billingModes: ['api-token', 'subscription-capacity', 'local-inference'],
    sources: [
      internalSource('crush'),
      {
        id: 'crush-cli-contract',
        label: 'Crush CLI runtime contract',
        url: 'https://github.com/charmbracelet/crush',
        observedAt: '2026-09-01',
        maxAgeDays: 30,
        confidence: 'verified',
        scope: 'runtime-upstream',
      },
    ],
  },
  openhands: unknownEvidence('openhands', ['ndjson'], 'configured-provider'),
  goose: unknownEvidence('goose', ['text'], 'configured-provider'),
  qwen: unknownEvidence('qwen', ['stream-json'], 'provider-native'),
  qoder: unknownEvidence('qoder', ['stream-json'], 'provider-native'),
  kimi: unknownEvidence('kimi', ['text'], 'provider-native'),
  aider: unknownEvidence('aider', ['text'], 'configured-provider'),
  '3code': unknownEvidence('3code', ['text'], 'configured-provider'),
  pi: unknownEvidence('pi', ['stdio-json-rpc'], 'configured-provider'),
  cursor: unknownEvidence('cursor', ['stream-json'], 'provider-native'),
  grok: {
    carriers: [{
      os: 'darwin',
      architectures: ['x64'],
      support: 'supported',
      sourceId: 'grok-build-contract',
      note: 'Verified locally through the production resolver with Grok Build 1.0.3.',
    }],
    transports: ['acp', 'headless-json-schema'],
    modelSelection: 'provider-native',
    advertisedModelIds: [
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-0309-reasoning',
      'grok-4.20-multi-agent-0309',
      'grok-4.6',
      'grok-build-0.1',
    ],
    billingModes: ['subscription-capacity', 'api-token'],
    pricing: [],
    sources: [
      internalSource('grok'),
      {
        id: 'grok-build-contract',
        label: 'Grok Build runtime contract',
        url: 'https://docs.x.ai/build/overview',
        observedAt: '2026-08-14',
        maxAgeDays: 30,
        confidence: 'verified',
        scope: 'runtime-upstream',
      },
    ],
  },
  'prime-agent': unknownEvidence('prime-agent', ['jsonl'], 'configured-provider'),
  'deepseek-harness': {
    carriers: [{
      os: 'darwin',
      architectures: ['x64'],
      support: 'supported',
      sourceId: 'deepseek-harness-acp-package',
      note: 'Verified on Intel macOS through the published ACP server and provider adapter packages.',
    }],
    transports: ['acp'],
    modelSelection: 'configured-provider',
    advertisedModelIds: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    billingModes: ['api-token'],
    pricing: [{
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      billingMode: 'api-token',
      unit: 'usd-per-million-tokens',
      inputUsd: 0.435,
      cachedInputUsd: 0.003625,
      outputUsd: 0.87,
      sourceId: 'deepseek-model-pricing',
    }],
    sources: [
      internalSource('deepseek-harness'),
      {
        id: 'deepseek-model-pricing',
        label: 'DeepSeek API models and pricing',
        url: 'https://api-docs.deepseek.com/quick_start/pricing',
        observedAt: '2026-08-14',
        maxAgeDays: 30,
        confidence: 'verified',
        scope: 'provider-official',
      },
      {
        id: 'deepseek-harness-upstream',
        label: 'DeepSeek Harness upstream runtime',
        url: 'https://github.com/deepseek-ai/deepseek-harness',
        observedAt: '2026-08-14',
        maxAgeDays: 14,
        confidence: 'verified',
        scope: 'runtime-upstream',
      },
      {
        id: 'deepseek-harness-acp-package',
        label: 'DeepSeek Harness ACP package',
        url: 'https://www.npmjs.com/package/@deepseek-ai/dsh-acp-demo',
        observedAt: '2026-08-14',
        maxAgeDays: 14,
        confidence: 'verified',
        scope: 'runtime-upstream',
      },
    ],
  },
} satisfies Record<OrchestratorRuntime, RuntimeEvidenceDefinition>;

export function validateRuntimeEvidenceDefinitions(
  definitions: Record<string, RuntimeEvidenceDefinition>,
): string[] {
  const errors: string[] = [];
  for (const runtime of ORCHESTRATOR_RUNTIME_IDS) {
    const definition = definitions[runtime];
    if (!definition) {
      errors.push(`${runtime}: missing evidence definition`);
      continue;
    }
    if (!definition.transports.length) errors.push(`${runtime}: transport evidence is required`);
    if (!definition.carriers.length) errors.push(`${runtime}: carrier evidence is required`);
    if (!definition.billingModes.length) errors.push(`${runtime}: billing mode evidence is required`);
    if (!definition.sources.length) errors.push(`${runtime}: provenance is required`);
    for (const source of definition.sources) {
      if (!source.url.startsWith('https://')) errors.push(`${runtime}/${source.id}: source URL must be HTTPS`);
      if (!Number.isFinite(Date.parse(source.observedAt))) errors.push(`${runtime}/${source.id}: observedAt must be an ISO date`);
      if (!Number.isFinite(source.maxAgeDays) || source.maxAgeDays <= 0) errors.push(`${runtime}/${source.id}: maxAgeDays must be positive`);
    }
    const sourceIds = new Set(definition.sources.map((source) => source.id));
    for (const carrier of definition.carriers) {
      if (!sourceIds.has(carrier.sourceId)) errors.push(`${runtime}/${carrier.os}: carrier source is missing`);
      if (carrier.support !== 'unknown' && !carrier.architectures.length) {
        errors.push(`${runtime}/${carrier.os}: known carrier support requires an architecture`);
      }
    }
    for (const price of definition.pricing) {
      if (!sourceIds.has(price.sourceId)) errors.push(`${runtime}/${price.modelId}: pricing source is missing`);
      if ([price.inputUsd, price.cachedInputUsd, price.outputUsd]
        .filter((value): value is number => value !== null)
        .some((value) => !Number.isFinite(value) || value < 0)) {
        errors.push(`${runtime}/${price.modelId}: pricing must be a non-negative number`);
      }
    }
  }
  for (const runtime of Object.keys(definitions)) {
    if (!ORCHESTRATOR_RUNTIME_IDS.includes(runtime as OrchestratorRuntime)) {
      errors.push(`${runtime}: unknown runtime evidence definition`);
    }
  }
  return errors;
}

export function runtimeEvidenceFreshness(
  definition: RuntimeEvidenceDefinition,
  now: Date,
): RuntimeEvidenceFreshness {
  const upstream = definition.sources.filter((source) => source.scope !== 'o8-contract');
  if (!upstream.length) return 'missing';
  return upstream.some((source) => {
    const observedAt = new Date(source.observedAt).getTime();
    return now.getTime() - observedAt <= source.maxAgeDays * 86_400_000;
  }) ? 'fresh' : 'stale';
}

async function probeVersion(binaryPath: string): Promise<string | null> {
  try {
    const invocation = cliInvocation(binaryPath, ['--version']);
    const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 64 * 1024,
    });
    return `${stdout}\n${stderr}`
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 160) ?? null;
  } catch {
    return null;
  }
}

export function parseGrokModelCatalogue(output: string): {
  defaultModel: string | null;
  models: string[];
} {
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, '');
  const defaultModel = normalized.match(/Default model:\s*([^\s]+)/i)?.[1] ?? null;
  const models = [...new Set(normalized.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(?:\*|-)\s+([^\s(]+)/);
    return match?.[1] ? [match[1]] : [];
  }))];
  return { defaultModel, models };
}

async function probeGrokModelCatalogue(binaryPath: string) {
  try {
    const invocation = cliInvocation(binaryPath, ['models']);
    const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: MODEL_CATALOGUE_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 128 * 1024,
    });
    const parsed = parseGrokModelCatalogue(`${stdout}\n${stderr}`);
    if (!parsed.models.length) throw new Error('Grok Build returned no model ids.');
    return {
      defaultModel: parsed.defaultModel,
      catalogue: {
        source: 'probe' as const,
        observedAt: new Date().toISOString(),
        total: parsed.models.length,
        targets: parsed.models.map((modelId) => ({
          providerId: 'x-ai',
          modelId,
          runtimeModelId: modelId,
          available: true,
        })),
        error: null,
      } satisfies NonNullable<RuntimeEvidenceEntry['modelCatalogue']>,
    };
  } catch (error) {
    return {
      defaultModel: null,
      catalogue: {
        source: null,
        observedAt: null,
        total: null,
        targets: [],
        error: error instanceof Error ? error.message : String(error),
      } satisfies NonNullable<RuntimeEvidenceEntry['modelCatalogue']>,
    };
  }
}

async function opencodeCatalogue(repoPath: string, fresh: boolean) {
  const launch = resolveAcpLaunch('opencode');
  if (!launch) return null;
  try {
    const probe = fresh
      ? await probeAcpModels('opencode', launch, repoPath, { force: true })
      : cachedAcpModels('opencode');
    if (!probe) return null;
    const modelIds = new Set(probe.models.map((model) => model.value));
    return {
      source: probe.source,
      observedAt: new Date(probe.probedAt).toISOString(),
      total: probe.models.length,
      targets: OPENCODE_TARGETS.map((target) => ({
        ...target,
        available: modelIds.has(target.runtimeModelId),
      })),
      error: null,
    } satisfies NonNullable<RuntimeEvidenceEntry['modelCatalogue']>;
  } catch (error) {
    return {
      source: null,
      observedAt: null,
      total: null,
      targets: OPENCODE_TARGETS.map((target) => ({ ...target, available: null })),
      error: error instanceof Error ? error.message : String(error),
    } satisfies NonNullable<RuntimeEvidenceEntry['modelCatalogue']>;
  }
}

export async function getRuntimeEvidenceSnapshot(options: {
  fresh?: boolean;
  now?: Date;
  repoPath?: string;
} = {}): Promise<RuntimeEvidenceSnapshot> {
  const errors = validateRuntimeEvidenceDefinitions(RUNTIME_EVIDENCE_DEFINITIONS);
  if (errors.length) throw new Error(`Invalid runtime evidence catalog: ${errors.join('; ')}`);

  const now = options.now ?? new Date();
  const adapters = new Map(getAllRuntimes().map((runtime) => [runtime.id, runtime]));
  const archiveRuntimes = new Set(listOwnedSessionLifecycles().map((entry) => entry.runtimeId));
  const catalogue = await opencodeCatalogue(options.repoPath ?? process.cwd(), Boolean(options.fresh));

  const runtimes = await Promise.all(ORCHESTRATOR_RUNTIME_IDS.map(async (runtimeId) => {
    const capability = getRuntimeCapability(runtimeId);
    const adapter = adapters.get(runtimeId);
    const authStatus = capability.dispatchable
      ? await detectRuntimeAuthStatus(runtimeId).catch(() => null)
      : null;
    const binaryPath = authStatus?.binaryPath ?? scanAndLink(capability.binaryName) ?? null;
    const definition = RUNTIME_EVIDENCE_DEFINITIONS[runtimeId];
    const grokCatalogue = runtimeId === 'grok' && binaryPath && options.fresh
      ? await probeGrokModelCatalogue(binaryPath)
      : null;
    return {
      runtimeId,
      label: capability.label,
      binaryName: capability.binaryName,
      dispatchable: capability.dispatchable,
      installed: Boolean(binaryPath),
      ready: capability.dispatchable
        ? Boolean(authStatus?.installed && authStatus.ready)
        : Boolean(binaryPath && adapter),
      installedVersion: binaryPath ? await probeVersion(binaryPath) : null,
      checkedAt: now.toISOString(),
      localCarrier: {
        os: process.platform,
        architecture: process.arch,
        installed: Boolean(binaryPath),
        ready: capability.dispatchable
          ? Boolean(authStatus?.installed && authStatus.ready)
          : Boolean(binaryPath && adapter),
      },
      capabilities: {
        discover: Boolean(adapter?.capabilities.discover),
        launch: Boolean(adapter?.capabilities.launch),
        resume: Boolean(adapter?.capabilities.resume),
        interrupt: Boolean(adapter?.capabilities.interrupt),
        transcript: Boolean(adapter?.capabilities.readTranscript),
        review: Boolean(adapter?.capabilities.reviewDiffs),
        telemetry: Boolean(adapter?.capabilities.costTelemetry),
        archive: archiveRuntimes.has(runtimeId) || BUILT_IN_ARCHIVE_RUNTIMES.has(runtimeId),
      },
      defaultModel: grokCatalogue?.defaultModel ?? capability.defaultModel ?? null,
      ...definition,
      freshness: runtimeEvidenceFreshness(definition, now),
      modelCatalogue: runtimeId === 'opencode'
        ? catalogue
        : runtimeId === 'grok'
          ? grokCatalogue?.catalogue ?? null
          : null,
    } satisfies RuntimeEvidenceEntry;
  }));

  return {
    schema: 'o8/runtime-evidence/v1',
    generatedAt: now.toISOString(),
    runtimes,
  };
}
