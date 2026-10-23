import { providerConfigEnvironment } from '@/lib/providers/spawn-environment';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { writeOwnedMcpArtifact } from '@/lib/providers/mcp-artifacts';
import path from 'node:path';

import { recordLaneEvent } from '@/lib/lane/events';
import {
  resolveWorkerMcpInjection,
  type ResolvedWorkerMcpServer,
} from '@/lib/mcp/worker-injection';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';

import type { OwnedRunMode, OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

export interface PreparedOwnedWorkerMcpConfig {
  configPath?: string;
  sandboxReadPaths: string[];
  servers: ResolvedWorkerMcpServer[];
}

function recordWorkerMcpEvent(
  session: OwnedSessionRecord,
  verb: 'mcp_injected' | 'mcp_injection_skipped',
  payload: Record<string, unknown>,
): void {
  if (!session.laneId) return;
  try {
    recordLaneEvent(session.laneId, verb, 'system', payload);
  } catch (error) {
    console.warn(`[owned-session] unable to record ${verb} for ${session.laneId}:`, error);
  }
}

export async function prepareOwnedWorkerMcpConfig({
  adapter,
  session,
  runId,
  mode,
  sandboxEnabled,
}: {
  adapter: OwnedRuntimeAdapter;
  session: OwnedSessionRecord;
  runId: string;
  mode: OwnedRunMode;
  sandboxEnabled: boolean;
}): Promise<PreparedOwnedWorkerMcpConfig> {
  const policy = credentialPolicyFingerprint(adapter.runtimeId);
  const assertCurrent = () => { if (credentialPolicyFingerprint(adapter.runtimeId) !== policy) throw new Error('Credentials changed during MCP preparation. Retry the launch.'); };
  if (session.executionPolicy !== undefined) {
    if (adapter.workerMcpInjection !== 'config-file') return { sandboxReadPaths: [], servers: [] };
    const configPath = writeOwnedMcpArtifact(adapter.runtimeId, runId, '{"mcpServers":{}}\n', assertCurrent);
    return { configPath, sandboxReadPaths: [configPath], servers: [] };
  }
  if (!session.packetId || !adapter.workerMcpInjection) {
    return { sandboxReadPaths: [], servers: [] };
  }

  const resolution = await resolveWorkerMcpInjection({
    packetId: session.packetId,
    worktreePath: session.repoPath,
    branch: session.branch ?? '',
    laneId: session.laneId,
  }, {
    resolveCommands: sandboxEnabled,
    pathValue: pathWithNodeRuntime(),
  });
  for (const skipped of resolution.skipped) {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', skipped);
  }
  if (resolution.error) {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', {
      reason: `Unable to load operator-registered MCP servers: ${resolution.error}`,
    });
    return { sandboxReadPaths: [], servers: [] };
  }
  if (resolution.servers.length === 0) return { sandboxReadPaths: [], servers: [] };

  const injectableServers = resolution.servers.map(server => ({ ...server, env: providerConfigEnvironment(server.env ?? {}, adapter.runtimeId) }));
  const commandReadPaths = sandboxEnabled
    ? injectableServers.map((server) => path.dirname(server.command))
    : [];
  if (adapter.workerMcpInjection === 'config-override') {
    recordWorkerMcpEvent(session, 'mcp_injected', {
      servers: injectableServers.map((server) => server.name),
      mode,
    });
    return {
      sandboxReadPaths: commandReadPaths,
      servers: injectableServers,
    };
  }

  try {
    const mcpServers = Object.fromEntries(injectableServers.map((server) => [
      server.name,
      {
        command: server.command,
        args: server.args,
        env: server.env ?? {},
      },
    ]));
    const configPath = writeOwnedMcpArtifact(adapter.runtimeId, runId, `${JSON.stringify({ mcpServers }, null, 2)}\n`, assertCurrent);
    recordWorkerMcpEvent(session, 'mcp_injected', {
      servers: injectableServers.map((server) => server.name),
      configPath,
      mode,
    });
    return {
      configPath,
      sandboxReadPaths: sandboxEnabled
        ? [configPath, ...commandReadPaths]
        : [],
      servers: injectableServers,
    };
  } catch (error) {
    recordWorkerMcpEvent(session, 'mcp_injection_skipped', {
      servers: injectableServers.map((server) => server.name),
      reason: error instanceof Error ? error.message : String(error),
    });
    return { sandboxReadPaths: [], servers: [] };
  }
}
