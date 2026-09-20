import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CatalogueGroup, CatalogueModel } from '@/lib/orchestrator/acp-model-catalogue';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 15 * 60_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/;
export const THREECODE_CATALOGUE_UNAVAILABLE = 'The 3code model catalogue is unavailable. Check the local 3code installation and configured providers.';
export const THREECODE_MODEL_UNAVAILABLE = 'The selected 3code model is unavailable. Choose a configured model from the 3code model list or clear the pin.';

let cache: { models: string[]; groups: CatalogueGroup[]; fetchedAt: number } | null = null;

type ConfiguredProvider = { name: string; models: string[] };

function threecodeConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), '3code', 'config');
}

function parseCfgString(value: string): string | null {
  const quoted = value.trim().match(/^"((?:[^"\\]|\\.)*)"\s*(?:[;#].*)?$/);
  if (!quoted) return null;
  try {
    return JSON.parse(`"${quoted[1]}"`) as string;
  } catch {
    return null;
  }
}

function splitConfiguredModels(value: string): string[] {
  return value
    .split(/\s+/)
    .map((raw) => raw.trim().replace(/^,+|,+$/g, ''))
    .filter((model) => MODEL_ID.test(model));
}

/** Reads only non-secret provider names and model lists from [provider] sections. */
export function parseThreecodeConfiguredProviders(config: string): ConfiguredProvider[] {
  const providers: Array<{ name: string | null; models: string[] }> = [];
  let current: { name: string | null; models: string[] } | null = null;
  for (const sourceLine of config.split(/\r?\n/)) {
    const line = sourceLine.trim();
    const section = line.match(/^\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (section) {
      current = null;
    }
    if (section?.[1] === 'provider') {
      current = { name: null, models: [] };
      providers.push(current);
      continue;
    }
    if (!current) continue;
    const name = line.match(/^name\s*=\s*(.+)$/);
    if (name) {
      const parsed = parseCfgString(name[1] ?? '');
      current.name = parsed && MODEL_ID.test(parsed) ? parsed : null;
      continue;
    }
    const models = line.match(/^models\s*=\s*(.+)$/);
    if (models) {
      const parsed = parseCfgString(models[1] ?? '');
      current.models = parsed ? splitConfiguredModels(parsed) : [];
    }
  }
  return providers.flatMap((provider) => provider.name && provider.models.length
    ? [{ name: provider.name, models: provider.models }]
    : []);
}

export function parseThreecodeGoodOutput(output: string): string[] {
  const models = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._/:-]*)\s{2,}/);
    const id = match?.[1];
    if (id && id.includes('.') && MODEL_ID.test(id)) models.add(id);
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

function catalogueGroups(models: readonly string[]): CatalogueGroup[] {
  const grouped = new Map<string, CatalogueModel[]>();
  for (const id of models) {
    const cut = id.indexOf('.');
    if (cut <= 0 || cut === id.length - 1) continue;
    const provider = id.slice(0, cut);
    const model: CatalogueModel = {
      id,
      label: id.slice(cut + 1),
      provider,
      efforts: [],
    };
    const current = grouped.get(provider);
    if (current) current.push(model);
    else grouped.set(provider, [model]);
  }
  return [...grouped.entries()]
    .map(([provider, entries]) => ({
      provider,
      models: entries.sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

async function queryConfiguredModels(): Promise<string[]> {
  const config = await readFile(threecodeConfigPath(), 'utf8');
  const binary = await resolveCli({
    runtimeId: '3code',
    binaryName: '3code',
    envOverride: 'O8_3CODE_BIN',
    versionArgs: ['--version'],
  });
  const invocation = cliInvocation(binary.path, ['good']);
  const result = await execFileAsync(invocation.command, invocation.args, {
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const knownGood = new Set(parseThreecodeGoodOutput(result.stdout));
  return [...new Set(parseThreecodeConfiguredProviders(config)
    .flatMap((provider) => provider.models.map((model) => `${provider.name}.${model}`))
    .filter((model) => knownGood.has(model)))]
    .sort((left, right) => left.localeCompare(right));
}

export async function getThreecodeModelCatalogue(options: { force?: boolean } = {}) {
  if (!options.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { ...cache, source: 'cache' as const };
  }
  try {
    const models = await queryConfiguredModels();
    if (!models.length) throw new Error('no configured known-good models');
    cache = { models, groups: catalogueGroups(models), fetchedAt: Date.now() };
    return { ...cache, source: 'live' as const };
  } catch {
    throw new Error(THREECODE_CATALOGUE_UNAVAILABLE);
  }
}

export async function assertThreecodeWorkerModelAvailable(model: string): Promise<void> {
  const candidate = model.trim();
  if (!candidate || !MODEL_ID.test(candidate)) {
    throw new Error('threecodeWorkerModel must be a configured 3code model id selected from the model list.');
  }
  const catalogue = await getThreecodeModelCatalogue({ force: true });
  if (!catalogue.models.includes(candidate)) {
    throw new Error(THREECODE_MODEL_UNAVAILABLE);
  }
}

export function isPlausibleThreecodeModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID.test(value.trim());
}
