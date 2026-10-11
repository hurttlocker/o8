import type { O8WebviewClient } from './o8-webview-client';

export const THREAD_NAVIGATION_TOOLS = [{
  name: 'o8_view_open_thread',
  description: 'Select an existing workspace and open a recorded task in its contextual Threads panel. Returns mounted workspace/repository/task identities only after the actual selection is mounted. Refuses missing or out-of-scope targets. A collapsed viewport returns panel_viewport_unavailable before selection changes, with the required width and o8_view_manage_window maximize recovery. Does not dispatch work, launch inference, create terminals or allocate previews. A mounted acknowledgement is agent-operation evidence, not human native-input acceptance.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: { type: 'string', description: 'Current activeWorkspaceId returned by o8_view_surface_state. Read it again after a workspace remount.' },
      repoPath: { type: 'string', description: 'Registered repository path containing the recorded task.' },
      taskId: { type: 'string', description: 'Recorded task identity from the task pool.' },
    },
    required: ['workspaceId', 'repoPath', 'taskId'],
    additionalProperties: false,
  },
}];
export function buildOpenThreadScript(target: { workspaceId: string; repoPath: string; taskId: string }) {
  return `(async () => {
    if (typeof window.__o8NavigateThread !== 'function') return JSON.stringify({ok:false,reason:'thread_navigation_unavailable'});
    return JSON.stringify(await window.__o8NavigateThread(${JSON.stringify(target)}));
  })()`;
}
export function createThreadNavigationHandlers(getClient: () => O8WebviewClient) {
  return {
    o8_view_open_thread: async (args: Record<string, unknown>) => {
      const target = { workspaceId: args.workspaceId, repoPath: args.repoPath, taskId: args.taskId };
      if (!Object.values(target).every((value) => typeof value === 'string' && value.trim())) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'invalid_target' }) }], isError: true };
      }
      try {
        const result = await getClient().evalJs(buildOpenThreadScript(target as { workspaceId: string; repoPath: string; taskId: string }));
        const data = JSON.parse(result.result) as { ok?: boolean };
        return { content: [{ type: 'text' as const, text: result.result }], isError: data.ok !== true };
      } catch {
        // Navigation may have landed before transport failure; do not retry blindly.
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'navigation_outcome_unknown', retryable: false }) }], isError: true };
      }
    },
  };
}
