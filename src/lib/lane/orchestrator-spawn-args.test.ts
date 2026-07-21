import { describe, expect, it } from 'vitest';

import {
  buildOrchestratorArgs,
  CLAUDE_SOLO_DISALLOWED_TOOLS,
  MANAGED_ORCHESTRATOR_SETTINGS,
} from './orchestrator-spawn-args';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';

function argsFor(toolProfile: ToolProfile = 'full'): string[] {
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

  it('keeps Claude repo tools but removes its native sub-agent in Solo', () => {
    const args = argsFor('solo');
    const denyIndex = args.indexOf('--disallowedTools');
    expect(denyIndex).toBeGreaterThan(-1);
    expect(args.slice(denyIndex + 1, denyIndex + 1 + CLAUDE_SOLO_DISALLOWED_TOOLS.length))
      .toEqual([...CLAUDE_SOLO_DISALLOWED_TOOLS]);
    expect(args).not.toContain('Read');
    expect(args).not.toContain('Edit');
    expect(args).not.toContain('Bash');
  });

  it('lets Fable work directly while retaining its own billing profile in Solo', () => {
    const args = argsFor('fable-solo');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Task');
    expect(args).not.toContain('Read');
    expect(args).not.toContain('Bash');
  });
});
