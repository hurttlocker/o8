/**
 * Tool-Spine emitter golden snapshots (Step A regression lock, pure).
 *
 * One shared fixture registry (one stdio external + one http external + operator
 * + cortex + codebase-memory) → assert each emitter's EXACT bytes/shape. These
 * pin the byte-level invariants every emission site relied on before any
 * consumer was repointed: entry order, the desktop `type`-strip, the codex TOML
 * layout, the gemini `httpUrl` key, surface filtering, and merge-preservation.
 */

import { describe, it, expect } from 'vitest';

import { entriesForSurface, type ToolRegistry } from './registry';
import { toClaudeServersMap, toClaudeJson } from './emit-claude';
import { toCodexToml } from './emit-codex';
import { toClaudeDesktopJson } from './emit-claude-desktop';
import { toOpenclawJson } from './emit-openclaw';
import { toGeminiSettings } from './emit-gemini';
import { toOpencodeJson } from './emit-opencode';

const fixture: ToolRegistry = {
  repoPath: '/repo',
  entries: [
    {
      id: 'external:ext-stdio',
      name: 'ext-stdio',
      source: 'external',
      label: 'ext-stdio',
      surfaces: ['claude-orchestrator', 'codex-orchestrator'],
      config: { type: 'stdio', command: 'node', args: ['ext.js'], env: { FOO: 'bar' } },
    },
    {
      id: 'external:ext-http',
      name: 'ext-http',
      source: 'external',
      label: 'ext-http',
      surfaces: ['claude-orchestrator', 'codex-orchestrator'],
      config: { type: 'http', url: 'https://ext.example/mcp', headers: { Authorization: 'Bearer x' } },
    },
    {
      id: 'builtin:operator',
      name: 'operator',
      source: 'builtin',
      label: 'o8 Operator',
      surfaces: ['claude-orchestrator', 'codex-orchestrator', 'claude-desktop', 'openclaw', 'gemini', 'opencode'],
      surfaceNames: { 'claude-desktop': 'o8', openclaw: 'o8', gemini: 'o8', opencode: 'o8' },
      config: { type: 'stdio', command: 'npx', args: ['tsx', 'operator.ts'], env: { O8_API_BASE: 'http://127.0.0.1:3001' } },
    },
    {
      id: 'builtin:cortex',
      name: 'cortex',
      source: 'builtin',
      label: 'Cortex Memory',
      surfaces: ['claude-orchestrator', 'codex-orchestrator'],
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', 'cortex.ts'],
        env: { CORTEX_API_BASE: 'http://127.0.0.1:3001', WS_TOKEN: 'tok' },
      },
    },
    {
      id: 'builtin:codebase-memory',
      name: 'codebase-memory',
      source: 'builtin',
      label: 'Codebase Memory',
      surfaces: ['claude-desktop', 'gemini', 'opencode'],
      config: { type: 'stdio', command: '/bin/cm', args: [], env: {} },
    },
  ],
};

describe('entriesForSurface', () => {
  it('filters by surface, in registry order, applying surfaceNames', () => {
    expect(entriesForSurface(fixture, 'claude-orchestrator').map((e) => e.name)).toEqual([
      'ext-stdio',
      'ext-http',
      'operator',
      'cortex',
    ]);
    // operator renamed to "o8"; cortex + externals excluded from gemini.
    expect(entriesForSurface(fixture, 'gemini').map((e) => e.name)).toEqual(['o8', 'codebase-memory']);
    expect(entriesForSurface(fixture, 'openclaw').map((e) => e.name)).toEqual(['o8']);
  });

  it('does not leak an entry to a surface it does not list', () => {
    expect(entriesForSurface(fixture, 'claude-desktop').map((e) => e.name)).not.toContain('cortex');
    expect(entriesForSurface(fixture, 'claude-desktop').map((e) => e.name)).not.toContain('ext-stdio');
  });
});

describe('toClaudeServersMap / toClaudeJson', () => {
  it('identity passthrough, type retained, externals→operator→cortex order, no codebase-memory', () => {
    const map = toClaudeServersMap(fixture);
    expect(Object.keys(map)).toEqual(['ext-stdio', 'ext-http', 'operator', 'cortex']);
    expect(map).toEqual({
      'ext-stdio': { type: 'stdio', command: 'node', args: ['ext.js'], env: { FOO: 'bar' } },
      'ext-http': { type: 'http', url: 'https://ext.example/mcp', headers: { Authorization: 'Bearer x' } },
      operator: { type: 'stdio', command: 'npx', args: ['tsx', 'operator.ts'], env: { O8_API_BASE: 'http://127.0.0.1:3001' } },
      cortex: {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', 'cortex.ts'],
        env: { CORTEX_API_BASE: 'http://127.0.0.1:3001', WS_TOKEN: 'tok' },
      },
    });
    expect(toClaudeJson(fixture)).toEqual({ mcpServers: map });
  });
});

describe('toCodexToml', () => {
  it('exact TOML: blank-line-separated blocks, type="http", sorted env/headers, no trailing newline', () => {
    const expected = [
      '[mcp_servers.ext-stdio]',
      'command = "node"',
      'args = ["ext.js"]',
      '',
      '[mcp_servers.ext-stdio.env]',
      'FOO = "bar"',
      '',
      '[mcp_servers.ext-http]',
      'type = "http"',
      'url = "https://ext.example/mcp"',
      '',
      '[mcp_servers.ext-http.headers]',
      'Authorization = "Bearer x"',
      '',
      '[mcp_servers.operator]',
      'command = "npx"',
      'args = ["tsx", "operator.ts"]',
      '',
      '[mcp_servers.operator.env]',
      'O8_API_BASE = "http://127.0.0.1:3001"',
      '',
      '[mcp_servers.cortex]',
      'command = "npx"',
      'args = ["tsx", "cortex.ts"]',
      '',
      '[mcp_servers.cortex.env]',
      'CORTEX_API_BASE = "http://127.0.0.1:3001"',
      'WS_TOKEN = "tok"',
    ].join('\n');
    expect(toCodexToml(fixture)).toBe(expected);
  });
});

describe('toClaudeDesktopJson', () => {
  it('strips type for stdio, includes codebase-memory, preserves unknown servers + top-level keys', () => {
    const existing = {
      theme: 'dark',
      mcpServers: {
        filesystem: { command: 'fs', args: ['/'] },
        playwright: { command: 'pw' },
      },
    };
    const out = toClaudeDesktopJson(fixture, existing);

    // Unknown servers + top-level key untouched (merge-preserve proof).
    expect(out.theme).toBe('dark');
    expect(out.mcpServers!.filesystem).toEqual({ command: 'fs', args: ['/'] });
    expect(out.mcpServers!.playwright).toEqual({ command: 'pw' });

    // o8 entry carries NO `type` field.
    expect(out.mcpServers!.o8).toEqual({ command: 'npx', args: ['tsx', 'operator.ts'], env: { O8_API_BASE: 'http://127.0.0.1:3001' } });
    expect(out.mcpServers!.o8).not.toHaveProperty('type');

    // codebase-memory present, env {} retained (matches legacy buildCodebaseMemoryConfig).
    expect(out.mcpServers!['codebase-memory']).toEqual({ command: '/bin/cm', args: [], env: {} });

    // Key order: existing first, then o8, then codebase-memory.
    expect(Object.keys(out.mcpServers!)).toEqual(['filesystem', 'playwright', 'o8', 'codebase-memory']);
  });

  it('does not mutate the input config', () => {
    const existing = { mcpServers: { filesystem: { command: 'fs' } } };
    const snapshot = JSON.stringify(existing);
    toClaudeDesktopJson(fixture, existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('starts a fresh mcpServers map when existing has none', () => {
    const out = toClaudeDesktopJson(fixture, {});
    expect(Object.keys(out.mcpServers!)).toEqual(['o8', 'codebase-memory']);
  });
});

describe('toOpenclawJson', () => {
  it('emits only o8 (operator), stdio-stripped, no codebase-memory', () => {
    expect(toOpenclawJson(fixture)).toEqual({
      servers: {
        o8: { command: 'npx', args: ['tsx', 'operator.ts'], env: { O8_API_BASE: 'http://127.0.0.1:3001' } },
      },
    });
  });
});

describe('toGeminiSettings', () => {
  it('emits o8 + codebase-memory; stdio implied by command (no type); empty env omitted', () => {
    expect(toGeminiSettings(fixture)).toEqual({
      mcpServers: {
        o8: { command: 'npx', args: ['tsx', 'operator.ts'], env: { O8_API_BASE: 'http://127.0.0.1:3001' } },
        'codebase-memory': { command: '/bin/cm', args: [] },
      },
    });
  });

  it('maps http transport to the httpUrl key (NOT url), with headers', () => {
    const httpReg: ToolRegistry = {
      repoPath: '/repo',
      entries: [
        {
          id: 'external:remote',
          name: 'remote',
          source: 'external',
          label: 'remote',
          surfaces: ['gemini'],
          config: { type: 'http', url: 'https://h/mcp', headers: { A: 'b' } },
        },
      ],
    };
    expect(toGeminiSettings(httpReg)).toEqual({ mcpServers: { remote: { httpUrl: 'https://h/mcp', headers: { A: 'b' } } } });
  });
});

describe('toOpencodeJson', () => {
  it('emits o8 + codebase-memory under `mcp`; type:local with folded command array; empty environment omitted', () => {
    expect(toOpencodeJson(fixture)).toEqual({
      mcp: {
        o8: { type: 'local', command: ['npx', 'tsx', 'operator.ts'], environment: { O8_API_BASE: 'http://127.0.0.1:3001' } },
        'codebase-memory': { type: 'local', command: ['/bin/cm'] },
      },
    });
  });

  it('maps http transport to type:remote with url (+headers)', () => {
    const httpReg: ToolRegistry = {
      repoPath: '/repo',
      entries: [
        {
          id: 'external:remote',
          name: 'remote',
          source: 'external',
          label: 'remote',
          surfaces: ['opencode'],
          config: { type: 'http', url: 'https://h/mcp', headers: { A: 'b' } },
        },
      ],
    };
    expect(toOpencodeJson(httpReg)).toEqual({ mcp: { remote: { type: 'remote', url: 'https://h/mcp', headers: { A: 'b' } } } });
  });
});
