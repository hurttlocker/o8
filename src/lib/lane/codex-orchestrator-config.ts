import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { serializeCodexMcpServers, toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { OrchestratorMcpServersConfig } from './orchestrator-mcp-config';
import { normalizeRepoPath, orchestratorDataDir, repoHash } from './orchestrator-session-core';

const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_CODEX_CONFIG_PATH = join(USER_CODEX_HOME, 'config.toml');
const CODEX_ORCHESTRATOR_HOME_DIR = orchestratorDataDir('codex-orchestrator');

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

function syncCodexAuthFiles(codexHome: string): void {
  for (const fileName of ['auth.json', 'installation_id', 'version.json']) {
    const sourcePath = join(USER_CODEX_HOME, fileName);
    if (!existsSync(sourcePath)) continue;
    const destPath = join(codexHome, fileName);
    copyFileSync(sourcePath, destPath);
    if (fileName === 'auth.json') chmodSync(destPath, 0o600);
  }
}

export function ensureCodexHome(repoPath: string, profile: ToolProfile = 'full'): string {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const suffix = profile === 'full' ? '' : `-${profile}`;
  const codexHome = join(CODEX_ORCHESTRATOR_HOME_DIR, `${repoHash(normalizedRepoPath)}${suffix}`);
  mkdirSync(codexHome, { recursive: true });
  const userConfigToml = existsSync(USER_CODEX_CONFIG_PATH)
    ? stripPluginSections(readFileSync(USER_CODEX_CONFIG_PATH, 'utf8'))
    : '';
  const mergedConfig = mergeCodexMcpConfig(
    userConfigToml,
    toCodexServersMap(buildToolRegistry(normalizedRepoPath, { profile })),
  );
  const configPath = join(codexHome, 'config.toml');
  writeFileSync(configPath, mergedConfig, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
  syncCodexAuthFiles(codexHome);
  return codexHome;
}
