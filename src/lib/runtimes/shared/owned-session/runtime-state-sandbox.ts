import path from 'node:path';

import type { OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

const IMMUTABLE_CONFIG_ENTRIES = [
  'auth.json', 'config.toml', 'AGENTS.md', 'agents', 'plugins', 'rules', 'skills',
  '.credentials.json', 'settings.json', 'settings.local.json', 'hooks',
  'mcp-servers', 'statusline.sh',
];

export function preparedRuntimeStateSandboxPolicy(
  adapter: OwnedRuntimeAdapter,
  session: OwnedSessionRecord,
  adapterEnv: Record<string, string>,
): { configHome?: string; immutablePaths?: string[] } {
  if (adapter.isolatedConfigHomeEnv && session.identity?.configHomeRef) {
    adapterEnv[adapter.isolatedConfigHomeEnv] = session.identity.configHomeRef;
  }
  const configHome = adapter.isolatedConfigHomeEnv
    ? adapterEnv[adapter.isolatedConfigHomeEnv]?.trim()
    : undefined;
  return configHome
    ? {
        configHome,
        immutablePaths: IMMUTABLE_CONFIG_ENTRIES.map((entry) => path.join(configHome, entry)),
      }
    : {};
}
