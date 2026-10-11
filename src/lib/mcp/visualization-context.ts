/** Only display tools receive transcript defaults. Other calls stay unchanged. */
export function withVisualizationContext<T>(message: T, context: { repoPath?: string; threadId?: string }): T {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const rpc = message as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  if (rpc.method !== 'tools/call' || !['o8_html_preview', 'o8_html_render'].includes(rpc.params?.name ?? '')) return message;
  const args = rpc.params?.arguments;
  if (args && (typeof args !== 'object' || Array.isArray(args))) return message;
  if (args?.packetId) return message;
  return { ...message, params: { ...rpc.params, arguments: { ...args,
    ...(!args?.repoPath && context.repoPath ? { repoPath: context.repoPath } : {}),
    ...(!args?.threadId && context.threadId ? { threadId: context.threadId } : {}),
  } } };
}
