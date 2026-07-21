import { fableLockoutArgs } from '@/lib/lane/fable-profile';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { claudeEffortFlagValue, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export type ClaudeOrchestratorPermissionMode = 'full' | 'plan';

export interface BuildOrchestratorArgsOptions {
  permissionMode: ClaudeOrchestratorPermissionMode;
  toolProfile: ToolProfile;
  effort: ThinkingEffort;
  mcpConfigPath: string;
  model: string;
  claudeSessionId: string | null;
  systemPrompt: string;
}

/** CLI settings override only hooks; auth and the operator's other settings remain available. */
export const MANAGED_ORCHESTRATOR_SETTINGS = JSON.stringify({ disableAllHooks: true });

/** Native Claude sub-agent entry point; repo read/edit/shell remain available. */
export const CLAUDE_SOLO_DISALLOWED_TOOLS = ['Task'] as const;

export function buildOrchestratorArgs(options: BuildOrchestratorArgsOptions): string[] {
  const isFable = options.toolProfile === 'fable';
  const isSolo = options.toolProfile === 'solo' || options.toolProfile === 'fable-solo';
  const basePermissionArgs = options.permissionMode === 'plan'
    ? ['--permission-mode', 'plan']
    : ['--dangerously-skip-permissions'];
  const permissionArgs = isFable
    ? fableLockoutArgs()
    : isSolo
      ? [...basePermissionArgs, '--disallowedTools', ...CLAUDE_SOLO_DISALLOWED_TOOLS]
      : basePermissionArgs;
  const strictMcpArgs = permissionArgs.includes('--strict-mcp-config') ? [] : ['--strict-mcp-config'];
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    ...permissionArgs,
    '--verbose',
    ...strictMcpArgs,
    '--mcp-config', options.mcpConfigPath,
    '--settings', MANAGED_ORCHESTRATOR_SETTINGS,
    '--model', options.model,
  ];

  if (options.effort && options.effort !== 'adaptive') {
    args.push('--effort', claudeEffortFlagValue(options.effort));
  }
  if (options.claudeSessionId) args.push('--resume', options.claudeSessionId);
  else args.push('--append-system-prompt', options.systemPrompt);
  return args;
}
