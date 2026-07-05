/**
 * Tool-Spine Step-B regression lock (live, DB-touching): the Claude orchestrator
 * consumer's WRITTEN FILE BODY.
 *
 * `ensureMcpConfig` (orchestrator-session.ts) was repointed from
 *   JSON.stringify({ mcpServers: getMcpServersConfig(repo) }, null, 2)
 * to
 *   JSON.stringify(toClaudeJson(buildToolRegistry(repo)), null, 2)
 *
 * The parity unit is the file body, not the servers map. This asserts the two
 * expressions produce byte-identical output (in one run → same registry, same
 * token, same order), plus the envelope invariants the consumer relied on: the
 * `{ mcpServers }` wrapper, NO trailing newline, `type` retained, and externals
 * carried + slotted first. `getMcpServersConfig` is untouched by Step B, so it
 * stays a faithful stand-in for the pre-repoint consumer body.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-claude-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { smokeDataDir } from './require-temp-data-dir';
import { getMcpServersConfig } from '@/lib/lane/orchestrator-mcp-config';
import { insertExternalMcpServer } from '@/lib/mcp/external-servers';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeJson } from '@/lib/mcp/tool-spine/emit-claude';

function main(): void {
  writeFileSync(join(smokeDataDir, 'ws-token'), 'consumer-smoke-fixed-token\n');
  writeFileSync(join(smokeDataDir, 'ws-port'), '3002\n');

  // Externals present — the path that drifts (ordering + passthrough through the envelope).
  insertExternalMcpServer({ name: 'zeta-stdio', transport: 'stdio', command: 'zeta', args: ['--x'], env: { K: 'v' }, enabled: true });
  insertExternalMcpServer({ name: 'alpha-http', transport: 'http', command: 'https://a/mcp', url: 'https://a/mcp', oauthToken: 'tok123', enabled: true });

  const repo = mkdtempSync(join(tmpdir(), 'claude-consumer-repo-'));

  // before: the legacy consumer body (orchestrator-session.ts pre-Step-B).
  const oldBody = JSON.stringify({ mcpServers: getMcpServersConfig(repo) }, null, 2);
  // after: the repointed consumer body (orchestrator-session.ts post-Step-B).
  const newBody = JSON.stringify(toClaudeJson(buildToolRegistry(repo)), null, 2);

  assert.strictEqual(newBody, oldBody, 'repointed file body is byte-identical to the legacy body');

  // Envelope invariants the consumer depends on.
  assert(!newBody.endsWith('\n'), 'no trailing newline (JSON.stringify(..., null, 2) only)');
  const parsed = JSON.parse(newBody) as { mcpServers: Record<string, { type?: string }> };
  assert.deepStrictEqual(Object.keys(parsed), ['mcpServers'], 'top-level envelope is exactly { mcpServers }');
  assert.strictEqual(parsed.mcpServers.operator.type, 'stdio', 'type field retained (not stripped for the orchestrator surface)');
  assert.deepStrictEqual(
    Object.keys(parsed.mcpServers),
    ['zeta-stdio', 'alpha-http', 'operator', 'cortex'],
    'externals slot first, then operator, cortex',
  );

  console.log('[tool-spine-claude-consumer-smoke] PASS (' + newBody.length + ' bytes)');
}

main();
