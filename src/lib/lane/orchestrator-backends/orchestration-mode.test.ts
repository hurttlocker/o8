import { describe, expect, it } from 'vitest';
import { applyOrchestrationMode, codexOrchestrationModeFlags, resolveOrchestratorExecutionMode } from './orchestration-mode';

describe('orchestrator execution mode', () => {
  it('defaults invalid and missing wire values to fleet', () => {
    expect(resolveOrchestratorExecutionMode(undefined)).toBe('fleet');
    expect(resolveOrchestratorExecutionMode('chat')).toBe('fleet');
  });

  it('marks a single-agent turn with an authoritative no-dispatch directive', () => {
    const resolved = applyOrchestrationMode('fix it', {
      orchestrationMode: 'single',
      permissionMode: 'full',
    });

    expect(resolved.options.permissionMode).toBe('full');
    expect(resolved.options.orchestrationMode).toBe('single');
    expect(resolved.message).toContain('dispatch disabled');
    expect(resolved.message).toContain('hardened Codex direct mode');
  });

  it('ignores user MCP config and disables native fan-out for Single', () => {
    expect(codexOrchestrationModeFlags('single')).toEqual([
      '--ignore-user-config',
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'mcp_servers={}',
      '-c', 'features.multi_agent=false',
      '-c', 'features.enable_fanout=false',
    ]);
    expect(codexOrchestrationModeFlags('fleet')).toEqual([]);
    expect(codexOrchestrationModeFlags('fusion')).toEqual([]);
  });

  it('turns fusion into the deep parallel cross-verification pass', () => {
    const resolved = applyOrchestrationMode('investigate it', { orchestrationMode: 'fusion' });

    expect(resolved.options.toolProfile).toBeUndefined();
    expect(resolved.message).toContain('Fusion mode');
    expect(resolved.message).toContain('parallel');
    expect(resolved.message).toContain('review the results against each other');
  });
});
