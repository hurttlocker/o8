import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { serializeCodexMcpServers, toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorMcpServersConfig } from './orchestrator-mcp-config';
import { normalizeRepoPath, orchestratorDataDir, repoHash } from './orchestrator-session-core';

const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_CODEX_CONFIG_PATH = join(USER_CODEX_HOME, 'config.toml');
const USER_CODEX_MODELS_CACHE_PATH = join(USER_CODEX_HOME, 'models_cache.json');
const CODEX_ORCHESTRATOR_HOME_DIR = orchestratorDataDir('codex-orchestrator');

export interface PreparedCodexHome {
  codexHome: string;
  model: string;
  note: string | null;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
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
  if (!configToml.trim()) return '';
  const lines = configToml.replace(/\r\n/g, '\n').split('\n');
  const nextLines: string[] = [];
  let skippingManagedSection = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (sectionMatch) {
      skippingManagedSection = isManagedMcpSection(sectionMatch[1].trim(), serverNames);
    }
    if (!skippingManagedSection) nextLines.push(line);
  }

  return nextLines.join('\n').trimEnd();
}

export function stripPluginSections(configToml: string): string {
  if (!configToml.trim()) return '';
  const lines = configToml.replace(/\r\n/g, '\n').split('\n');
  const nextLines: string[] = [];
  let skippingPluginSection = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      skippingPluginSection = name === 'marketplaces'
        || name.startsWith('marketplaces.')
        || name === 'plugins'
        || name.startsWith('plugins.');
    }
    if (!skippingPluginSection) nextLines.push(line);
  }

  return nextLines.join('\n').trimEnd();
}

export function mergeCodexMcpConfig(baseConfigToml: string, servers: OrchestratorMcpServersConfig): string {
  const retainedConfig = stripManagedMcpSections(baseConfigToml, Object.keys(servers));
  const mcpConfig = serializeCodexMcpServers(servers);
  return `${[retainedConfig, mcpConfig].filter(Boolean).join('\n\n')}\n`;
}

function cachedCodexModelIds(): string[] | null {
  if (!existsSync(USER_CODEX_MODELS_CACHE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(USER_CODEX_MODELS_CACHE_PATH, 'utf8')) as {
      models?: Array<{ slug?: unknown }>;
    };
    if (!Array.isArray(parsed.models)) return null;
    return parsed.models
      .map((model) => typeof model.slug === 'string' ? model.slug.trim() : '')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function resolveCachedCodexOrchestratorModel(requestedModel: string): {
  model: string;
  note: string | null;
} {
  if (requestedModel !== MODEL_IDS.raw.openAiGpt6Astra) {
    return { model: requestedModel, note: null };
  }
  const cachedModelIds = cachedCodexModelIds();
  if (cachedModelIds === null || cachedModelIds.includes(requestedModel)) {
    return { model: requestedModel, note: null };
  }
  const model = MODEL_IDS.raw.openAiGpt56Sol;
  return {
    model,
    note: `Host models cache does not list ${requestedModel}; using ${model} for this Codex orchestrator launch.`,
  };
}

function pinCodexOrchestratorModel(
  configToml: string,
  model: string,
  note: string | null,
): string {
  const lines = configToml.replace(/\r\n/g, '\n').split('\n');
  const nextLines: string[] = [];
  let topLevel = true;
  let wroteModel = false;
  const writeModel = () => {
    if (wroteModel) return;
    if (note) nextLines.push(`# o8: ${note}`);
    nextLines.push(`model = ${JSON.stringify(model)}`);
    wroteModel = true;
  };

  for (const line of lines) {
    if (topLevel && /^\s*\[/.test(line)) {
      writeModel();
      if (nextLines.length && nextLines[nextLines.length - 1] !== '') nextLines.push('');
      topLevel = false;
    }
    if (topLevel && /^\s*model\s*=/.test(line)) {
      writeModel();
      continue;
    }
    nextLines.push(line);
  }
  if (!wroteModel) writeModel();
  return `${nextLines.join('\n').trimEnd()}\n`;
}

function syncCodexAuthFiles(codexHome: string): void {
  for (const fileName of ['auth.json', 'installation_id', 'version.json']) {
    const sourcePath = join(USER_CODEX_HOME, fileName);
    if (!existsSync(sourcePath)) continue;
    const destPath = join(codexHome, fileName);
    copyFileSync(sourcePath, destPath);
    if (fileName === 'auth.json') chmodSync(destPath, 0o600);
  }
}

export function prepareCodexHome(
  repoPath: string,
  profile: ToolProfile = 'full',
  requestedModel: string = MODEL_IDS.codexDefault,
): PreparedCodexHome {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const suffix = profile === 'full' ? '' : `-${profile}`;
  const codexHome = join(CODEX_ORCHESTRATOR_HOME_DIR, `${repoHash(normalizedRepoPath)}${suffix}`);
  mkdirSync(codexHome, { recursive: true });
  const resolved = resolveCachedCodexOrchestratorModel(requestedModel);
  const userConfigToml = existsSync(USER_CODEX_CONFIG_PATH)
    ? stripPluginSections(readFileSync(USER_CODEX_CONFIG_PATH, 'utf8'))
    : '';
  const mergedConfig = mergeCodexMcpConfig(
    pinCodexOrchestratorModel(userConfigToml, resolved.model, resolved.note),
    toCodexServersMap(buildToolRegistry(normalizedRepoPath, { profile })),
  );
  const configPath = join(codexHome, 'config.toml');
  writeFileSync(configPath, mergedConfig, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
  syncCodexAuthFiles(codexHome);
  return { codexHome, ...resolved };
}

export function ensureCodexHome(repoPath: string, profile: ToolProfile = 'full'): string {
  return prepareCodexHome(repoPath, profile).codexHome;
}
