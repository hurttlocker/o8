import { describe, expect, it } from 'vitest';

import {
  buildMcpConfigHashMaterial,
  fingerprintMcpConfig,
  firstMcpConfigDivergence,
} from './orchestrator-mcp-fingerprint';

function configWith(serverEntries: Array<[string, Record<string, unknown>]>) {
  return { mcpServers: Object.fromEntries(serverEntries) };
}

describe('orchestrator MCP hash material', () => {
  it('produces the same material and hash for the same semantic inputs', () => {
    const config = configWith([
      ['operator', { type: 'stdio', command: 'node', args: ['operator.mjs'], env: { O8_API_BASE: 'http://127.0.0.1:47120' } }],
    ]);

    expect(buildMcpConfigHashMaterial(config)).toBe(buildMcpConfigHashMaterial(config));
    expect(fingerprintMcpConfig(config).hash).toBe(fingerprintMcpConfig(config).hash);
  });

  it('excludes volatile object insertion order from the hash', () => {
    const first = configWith([
      ['operator', { type: 'stdio', command: 'node', args: ['operator.mjs'] }],
      ['cortex', { type: 'stdio', command: 'node', args: ['cortex.mjs'] }],
    ]);
    const reordered = configWith([
      ['cortex', { args: ['cortex.mjs'], command: 'node', type: 'stdio' }],
      ['operator', { args: ['operator.mjs'], command: 'node', type: 'stdio' }],
    ]);

    expect(fingerprintMcpConfig(reordered).hash).toBe(fingerprintMcpConfig(first).hash);
  });

  it('changes the hash when a semantic server is added and names its first divergent key', () => {
    const previous = configWith([
      ['operator', { type: 'stdio', command: 'node', args: ['operator.mjs'] }],
    ]);
    const next = configWith([
      ['operator', { type: 'stdio', command: 'node', args: ['operator.mjs'] }],
      ['trading', { type: 'http', url: 'https://example.test/mcp' }],
    ]);
    const previousFingerprint = fingerprintMcpConfig(previous);
    const nextFingerprint = fingerprintMcpConfig(next);

    expect(nextFingerprint.hash).not.toBe(previousFingerprint.hash);
    expect(firstMcpConfigDivergence(previousFingerprint.material, nextFingerprint.material))
      .toBe('mcpServers.trading');
  });
});
