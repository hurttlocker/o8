/**
 * Tool-Spine Step-F containment test (live): OpenClaw passthrough → registry emit.
 *
 * F is the one DELIBERATE behavior change — the governed o8 profile's mcp entry
 * now comes from the registry projection, not the user's pre-registered passthrough.
 * There is NO byte baseline, so the proof is CONTAINMENT: build the profile both
 * ways from the SAME source and prove F touched ONLY mcp.servers.o8.
 *
 * PACKAGED mode (the registry o8 = the stable {command:<node>, args:[<bundled>]}
 * shape — the dev tsx-vs-npx divergence is spec risk #3).
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-openclaw-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './require-temp-data-dir';
import { buildGovernedO8Profile } from '@/lib/lane/orchestrator-backends/openclaw';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';

// A realistic source openclaw.json: agents, gateway, channels/bindings (to be
// stripped), unrelated top-level keys (to be preserved), and mcp.servers with a
// HAND-CUSTOMIZED o8 (different from the registry) PLUS another server `foo`.
const SOURCE = {
  agents: { list: [{ id: 'main', model: 'codex', toolPolicy: 'all' }], defaults: { x: 1 } },
  gateway: { host: '127.0.0.1', extra: 'keep-me' },
  channels: { telegram: { token: 'SECRET' } },
  bindings: { discord: 'guild-123' },
  auth: { provider: 'oauth', token: 'KEEP' },
  models: { default: 'gpt-5.5' },
  mcp: {
    servers: {
      o8: { command: '/custom/tsx', args: ['/custom/operator.ts'], env: { O8_API_BASE: 'http://127.0.0.1:9999' } },
      foo: { command: 'foo-mcp', args: [] },
    },
  },
};

function stripMcp(profile: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(profile)) as Record<string, unknown>; // normalizes (drops undefined)
  delete clone.mcp;
  return clone;
}

function main(): void {
  // Force PACKAGED resolution for the registry o8 entry.
  const bundleDir = mkdtempSync(join(tmpdir(), 'oc-bundle-'));
  const bundlePath = join(bundleDir, 'operator-mcp-server.mjs');
  const proxyPath = join(bundleDir, 'operator-mcp-proxy.mjs');
  writeFileSync(bundlePath, '');
  writeFileSync(proxyPath, '');
  process.env.O8_BUNDLED_MCP_PATH = bundlePath;
  process.env.O8_BUNDLED_MCP_DIR = bundleDir;
  process.env.O8_NODE_BIN = '/usr/local/bin/node';

  const passthroughO8 = SOURCE.mcp.servers.o8; // what the OLD code used
  const registryO8 = toOpenclawJson(buildToolRegistry(process.cwd())).servers['o8']; // what the NEW code uses

  const before = buildGovernedO8Profile(SOURCE as unknown as Record<string, unknown>, passthroughO8);
  const after = buildGovernedO8Profile(SOURCE as unknown as Record<string, unknown>, registryO8);

  // ── Containment: F touched NOTHING outside mcp.servers.o8 ──
  assert.deepStrictEqual(stripMcp(before), stripMcp(after), 'everything outside mcp is byte-identical (governed agents, gateway, strips, top-level keys)');

  // Defensive spot-checks of the unchanged blast radius (both profiles).
  for (const [label, p] of [['before', before], ['after', after]] as const) {
    assert.strictEqual((p as { channels?: unknown }).channels, undefined, `${label}: channels stripped`);
    assert.strictEqual((p as { bindings?: unknown }).bindings, undefined, `${label}: bindings stripped`);
    assert.deepStrictEqual((p.auth as unknown), { provider: 'oauth', token: 'KEEP' }, `${label}: unrelated top-level key preserved`);
    assert.strictEqual((p.gateway as { host?: string }).host, '127.0.0.1', `${label}: gateway base preserved`);
    // mcp.servers is o8-ONLY by construction — source `foo` is dropped (governance).
    assert.deepStrictEqual(Object.keys((p.mcp as { servers: Record<string, unknown> }).servers), ['o8'], `${label}: mcp.servers is o8-only (foo dropped)`);
    assert(!JSON.stringify(p.mcp).includes('foo-mcp'), `${label}: other source mcp servers do not leak`);
  }

  const beforeO8 = (before.mcp as { servers: Record<string, unknown> }).servers.o8;
  const afterO8 = (after.mcp as { servers: Record<string, unknown> }).servers.o8;

  // Old used the passthrough; new uses the registry projection (the intended delta).
  assert.deepStrictEqual(beforeO8, passthroughO8, 'before: o8 = the source passthrough');
  assert.deepStrictEqual(afterO8, registryO8, 'after: o8 = the registry openclaw projection');
  assert.deepStrictEqual(afterO8, { command: '/usr/local/bin/node', args: [proxyPath], env: { O8_API_BASE: 'http://127.0.0.1:3001' } }, 'registry o8 = operator stdio entry (packaged)');
  assert(!('type' in (afterO8 as Record<string, unknown>)), 'registry o8 entry has no type field');
  assert.notStrictEqual(JSON.stringify(beforeO8), JSON.stringify(afterO8), 'the o8 entry IS the one intended change');

  console.log('[tool-spine-openclaw-consumer-smoke] PASS — containment holds; only mcp.servers.o8 changed');
  console.log('  o8 BEFORE (passthrough):', JSON.stringify(beforeO8));
  console.log('  o8 AFTER  (registry)   :', JSON.stringify(afterO8));
}

main();
