import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { OrchestratorTurnOptions } from './types';

const SINGLE_TURN_DIRECTIVE = [
  '[Single agent mode — dispatch disabled]',
  'Work this turn yourself in hardened Codex direct mode. Mission, task, worker-packet, MCP, and native sub-agent launch capabilities are unavailable. Use your own read, edit, shell, and test tools end-to-end.',
].join('\n');

const FUSION_TURN_DIRECTIVE = [
  '[Fusion mode — deep multi-agent pass]',
  'Run a deep parallel pass: dispatch independent worker missions for implementation, fan analysis and cross-checking out to native sub-agents where available, review the results against each other, then synthesize one verified answer and governed diff.',
].join('\n');

export function resolveOrchestratorExecutionMode(value: unknown): OrchestratorExecutionMode {
  return value === 'single' || value === 'fusion' ? value : 'fleet';
}

export function codexOrchestrationModeFlags(mode: OrchestratorExecutionMode | undefined): string[] {
  if (mode !== 'single') return [];
  return [
    '--ignore-user-config',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'mcp_servers={}',
    '-c', 'features.multi_agent=false',
    '-c', 'features.enable_fanout=false',
  ];
}

export function applyOrchestrationMode(
  message: string,
  options: OrchestratorTurnOptions = {},
): { message: string; options: OrchestratorTurnOptions } {
  const orchestrationMode = options.orchestrationMode ?? 'fleet';
  if (orchestrationMode === 'fleet') return { message, options };

  const directive = orchestrationMode === 'single'
    ? SINGLE_TURN_DIRECTIVE
    : FUSION_TURN_DIRECTIVE;
  return {
    message: `${directive}\n\n${message}`,
    options,
  };
}
