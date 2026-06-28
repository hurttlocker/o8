/**
 * Back-compat shim over the Tool-Spine registry.
 *
 * `getMcpServersConfig` used to assemble the orchestrator MCP server map inline
 * (operator + cortex + DB externals). That assembly — and its resolvers — moved
 * to `@/lib/mcp/tool-spine/build.ts`; this now re-derives the identical map via
 * the Claude-orchestrator projection of the registry. Output is key-for-key
 * byte-identical to the legacy implementation (golden-locked in
 * `tests/smoke/tool-spine-parity-smoke.ts`). The two existing callers
 * (orchestrator-session.ts, codex-orchestrator-session.ts) are untouched.
 */

import type { OrchestratorMcpServerConfig } from '@/lib/mcp/external-servers';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeServersMap } from '@/lib/mcp/tool-spine/emit-claude';

export type OrchestratorMcpServersConfig = Record<string, OrchestratorMcpServerConfig>;

export function getMcpServersConfig(repoPath: string): OrchestratorMcpServersConfig {
  return toClaudeServersMap(buildToolRegistry(repoPath));
}
