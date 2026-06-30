/**
 * Tool-Spine Step-C regression lock (live, DB-touching): the Codex orchestrator
 * consumer's WRITTEN FILE — the full config.toml from mergeCodexMcpConfig.
 *
 * ensureCodexHome was repointed from getMcpServersConfig(repo) to
 * toCodexServersMap(buildToolRegistry(repo)); the serializer moved to
 * emit-codex.ts. The strip + merge + trailing-newline stay in the consumer.
 * The parity unit is the merged config.toml, covering BOTH branches of
 * `${[retained, managed].filter(Boolean).join('\n\n')}\n`:
 *   - retained-present → retained\n\nmanaged\n  (user section kept, stale o8
 *     block stripped — the idempotency the merge exists for)
 *   - retained-absent  → managed\n             (fresh install)
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-codex-consumer-smoke.ts
 */

import assert from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMcpServersConfig } from '@/lib/lane/orchestrator-mcp-config';
import { mergeCodexMcpConfig } from '@/lib/lane/codex-orchestrator-session';
import { insertExternalMcpServer } from '@/lib/mcp/external-servers';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { serializeCodexMcpServers, toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';

// A user's own non-o8 section (must be retained) + a STALE o8-managed block
// (must be stripped, not duplicated).
const RETAINED_FIXTURE = [
  '[user_tool]',
  'enabled = true',
  '',
  '[mcp_servers.operator]',
  'command = "STALE"',
  'args = ["old"]',
  '',
].join('\n');

function main(): void {
  const dataDir = process.env.CORTEX_IDE_DATA_DIR;
  assert(dataDir && existsSync(dataDir), 'CORTEX_IDE_DATA_DIR must be set to a temp dir');
  writeFileSync(join(dataDir, 'ws-token'), 'codex-consumer-fixed-token\n');
  writeFileSync(join(dataDir, 'ws-port'), '3002\n');

  insertExternalMcpServer({ name: 'zeta-stdio', transport: 'stdio', command: 'zeta', args: ['--x'], env: { K: 'v' }, enabled: true });
  insertExternalMcpServer({ name: 'alpha-http', transport: 'http', command: 'https://a/mcp', url: 'https://a/mcp', oauthToken: 'tok123', enabled: true });

  const repo = mkdtempSync(join(tmpdir(), 'codex-consumer-repo-'));

  // The map fed to the consumer is byte-identical to the legacy getMcpServersConfig.
  const registry = buildToolRegistry(repo);
  const servers = toCodexServersMap(registry);
  assert.deepStrictEqual(servers, getMcpServersConfig(repo), 'codex servers map == legacy getMcpServersConfig');

  const managed = serializeCodexMcpServers(servers);
  assert(managed.startsWith('[mcp_servers.zeta-stdio]'), 'externals serialize first');
  assert(managed.includes('[mcp_servers.operator]') && managed.includes('[mcp_servers.cortex]'), 'operator + cortex present');
  assert(!managed.endsWith('\n'), 'serializer adds no trailing newline');

  // ── Fresh branch: retained empty → managed\n ──
  const fresh = mergeCodexMcpConfig('', servers);
  assert.strictEqual(fresh, `${managed}\n`, 'fresh install = managed blocks + single trailing newline');

  // ── Retained branch: user section kept, stale o8 block stripped ──
  const retained = mergeCodexMcpConfig(RETAINED_FIXTURE, servers);
  // Strip removes [mcp_servers.operator] (and its env) but keeps [user_tool].
  const expectedRetainedPrefix = '[user_tool]\nenabled = true';
  assert.strictEqual(retained, `${expectedRetainedPrefix}\n\n${managed}\n`, 'retained\\n\\nmanaged\\n with trailing newline');
  assert(retained.includes('[user_tool]'), 'user section retained');
  assert(!retained.includes('STALE'), 'stale o8-managed block stripped (no duplication)');
  // Exactly one operator block survives (the fresh one), proving the strip.
  assert.strictEqual(retained.match(/\[mcp_servers\.operator]/g)?.length, 1, 'exactly one operator block after merge');

  console.log('[tool-spine-codex-consumer-smoke] PASS (retained ' + retained.length + 'B, fresh ' + fresh.length + 'B)');
}

main();
