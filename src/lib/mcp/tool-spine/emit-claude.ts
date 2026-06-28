/**
 * Emitter: Claude orchestrator `--mcp-config` JSON (Set A).
 *
 * Identity passthrough of `config` under the per-surface key, in entry order,
 * with `type` retained. The writer (orchestrator-session.ts) owns the
 * no-trailing-newline detail.
 */

import type { OrchestratorMcpServerConfig } from '@/lib/mcp/external-servers';
import { entriesForSurface, type ToolRegistry } from './registry';

export function toClaudeServersMap(r: ToolRegistry): Record<string, OrchestratorMcpServerConfig> {
  const out: Record<string, OrchestratorMcpServerConfig> = {};
  for (const { name, config } of entriesForSurface(r, 'claude-orchestrator')) {
    out[name] = config;
  }
  return out;
}

export function toClaudeJson(r: ToolRegistry): { mcpServers: Record<string, OrchestratorMcpServerConfig> } {
  return { mcpServers: toClaudeServersMap(r) };
}
