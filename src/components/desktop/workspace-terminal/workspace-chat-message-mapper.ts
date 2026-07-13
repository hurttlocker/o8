import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { WorkspaceLlmMessage } from '@/components/desktop/workspace-terminal/types';

export function mapWorkspaceTranscriptMessages(
  messages: MobileTranscriptEntry[],
  selectedModelLabel?: string,
): WorkspaceLlmMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role === 'system' || message.role === 'tool' ? 'assistant' : message.role,
    content: message.text,
    model: message.model ?? (message.role === 'assistant' ? selectedModelLabel : undefined),
    timestamp: message.timestamp ?? Date.now(),
    tokens: message.tokens,
    costUsd: message.costUsd,
    toolCalls: message.toolCalls?.map((tool) => ({
      name: tool.name,
      // The workspace chat pane keeps a 3-status model; the transcript's newer
      // 'error' status collapses to 'done' here (this surface has no error badge).
      status: tool.status === 'error' ? 'done' as const : (tool.status ?? 'done'),
      args: tool.args,
      preview: tool.preview,
    })),
    sources: message.sources,
    thinking: message.thinking,
    thinkingSteps: message.thinkingSteps,
    thinkingDurationMs: message.thinkingDurationMs,
    recalledFacts: message.recalledFacts,
    claudeCodeEvents: message.claudeCodeEvents,
    isError: /^error:/i.test(message.text.trim()),
  }));
}
