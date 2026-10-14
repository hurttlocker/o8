import { providerFromConfig } from './controlled-provider';
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
): { configHome?: string; writablePaths?: string[]; immutablePaths?: string[] } {
  if (adapter.isolatedConfigHomeEnv && session.identity?.configHomeRef && !providerFromConfig(session.runtimeConfig)) {
    adapterEnv[adapter.isolatedConfigHomeEnv] = session.identity.configHomeRef;
  }
  const configRoot = adapter.isolatedConfigHomeEnv
    ? adapterEnv[adapter.isolatedConfigHomeEnv]?.trim()
    : undefined;
  if (adapter.configStateSubdir && !/^[a-zA-Z0-9_-]+$/.test(adapter.configStateSubdir)) throw new Error('Invalid runtime state subdirectory.');
  const configHome = configRoot && adapter.configStateSubdir ? path.join(configRoot, adapter.configStateSubdir) : configRoot;
  if (adapter.sessionDataSubdir && !/^[a-zA-Z0-9_-]+$/.test(adapter.sessionDataSubdir)) throw new Error('Invalid runtime data subdirectory.');
  const dataRoot = adapter.sessionDataHomeEnv ? adapterEnv[adapter.sessionDataHomeEnv]?.trim() : undefined;
  const dataHome = dataRoot && adapter.sessionDataSubdir ? path.join(dataRoot, adapter.sessionDataSubdir) : dataRoot;
  const writablePaths = [configHome, dataHome].filter((value): value is string => Boolean(value));
  if (writablePaths.some(value => !path.isAbsolute(value))) throw new Error('Runtime state roots must be absolute.');
  return configHome
    ? {
        configHome,
        writablePaths,
        immutablePaths: IMMUTABLE_CONFIG_ENTRIES.map((entry) => path.join(configHome, entry)),
      }
    : writablePaths.length ? { writablePaths } : {};
}
