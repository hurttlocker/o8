import { describe, expect, it } from 'vitest';

import { buildOrchestratorArgs, MANAGED_ORCHESTRATOR_SETTINGS } from './orchestrator-spawn-args';

function argsFor(toolProfile: 'full' | 'fable' = 'full'): string[] {
  return buildOrchestratorArgs({
    permissionMode: 'full',
    toolProfile,
    effort: 'adaptive',
    mcpConfigPath: '/tmp/o8-managed-mcp.json',
    model: 'claude-test',
    claudeSessionId: null,
    systemPrompt: 'managed prompt',
  });
}

describe('buildOrchestratorArgs managed isolation', () => {
  it('strictly limits a full orchestrator spawn to the o8-written MCP config', () => {
    const args = argsFor();
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2))
      .toEqual(['--mcp-config', '/tmp/o8-managed-mcp.json']);
  });

  it('disables user and project hooks without replacing unrelated settings or auth', () => {
    const args = argsFor();
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2))
      .toEqual(['--settings', MANAGED_ORCHESTRATOR_SETTINGS]);
    expect(JSON.parse(MANAGED_ORCHESTRATOR_SETTINGS)).toEqual({ disableAllHooks: true });
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--safe-mode');
  });

  it('keeps the existing Fable lockout and emits strict MCP isolation once', () => {
    const args = argsFor('fable');
    expect(args).toContain('--disallowedTools');
    expect(args.filter((arg) => arg === '--strict-mcp-config')).toHaveLength(1);
  });
});
