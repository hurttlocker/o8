export type OrchestratorEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id?: string | null; name: string; input: unknown }
  | { type: 'tool_result'; id?: string | null; name: string; input?: unknown; output: string }
  | { type: 'done'; sessionId: string | null; cost: number | null }
  | { type: 'error'; error: string };

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string } | Record<string, unknown>>;
};

interface ToolCallTracker {
  recordToolUse: (tool: { id?: string | null; name: string; input: unknown }) => void;
  resolveToolResult: (toolUseId?: string | null) => { id?: string | null; name: string; input: unknown } | null;
}

export function createToolCallTracker(): ToolCallTracker {
  const pendingById = new Map<string, { id?: string | null; name: string; input: unknown }>();
  const pendingQueue: Array<{ id?: string | null; name: string; input: unknown }> = [];

  return {
    recordToolUse(tool) {
      if (tool.id && pendingById.has(tool.id)) {
        return;
      }
      pendingQueue.push(tool);
      if (tool.id) {
        pendingById.set(tool.id, tool);
      }
    },
    resolveToolResult(toolUseId) {
      if (toolUseId) {
        const matched = pendingById.get(toolUseId) ?? null;
        if (!matched) return null;
        pendingById.delete(toolUseId);
        const queueIndex = pendingQueue.findIndex((tool) => tool.id === toolUseId);
        if (queueIndex >= 0) pendingQueue.splice(queueIndex, 1);
        return matched;
      }

      const matched = pendingQueue.shift() ?? null;
      if (!matched) return null;
      if (matched.id) pendingById.delete(matched.id);
      return matched;
    },
  };
}

function stringifyToolResultContent(content: ContentBlock['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        return item.text;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n');
}

export function processStreamEvent(
  event: Record<string, unknown>,
  onEvent: (e: OrchestratorEvent) => void,
  onSessionId: (id: string) => void,
  onCost: (cost: number) => void,
  tracker: ToolCallTracker,
): void {
  const type = event.type as string | undefined;

  switch (type) {
    case 'system': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      break;
    }

    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) break;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        onEvent({ type: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent({ type: 'thinking', text: delta.thinking });
      }
      break;
    }

    case 'content_block_start': {
      const block = event.content_block as ContentBlock | undefined;
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const nextTool = {
          id: typeof block.id === 'string' ? block.id : null,
          name: block.name,
          input: block.input ?? null,
        };
        tracker.recordToolUse(nextTool);
        onEvent({ type: 'tool_use', ...nextTool });
      }
      break;
    }

    case 'assistant': {
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content as ContentBlock[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          onEvent({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const nextTool = {
            id: typeof block.id === 'string' ? block.id : null,
            name: block.name,
            input: block.input ?? null,
          };
          tracker.recordToolUse(nextTool);
          onEvent({ type: 'tool_use', ...nextTool });
        }
      }
      break;
    }

    case 'user': {
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content as ContentBlock[]) {
        if (block.type !== 'tool_result') continue;
        const matchedTool = tracker.resolveToolResult(typeof block.tool_use_id === 'string' ? block.tool_use_id : null);
        onEvent({
          type: 'tool_result',
          id: matchedTool?.id ?? (typeof block.tool_use_id === 'string' ? block.tool_use_id : null),
          name: matchedTool?.name ?? '',
          input: matchedTool?.input,
          output: stringifyToolResultContent(block.content),
        });
      }
      break;
    }

    case 'result': {
      const id = event.session_id as string | undefined;
      if (id) onSessionId(id);
      const totalCost = event.total_cost_usd as number | undefined;
      if (typeof totalCost === 'number') onCost(totalCost);
      break;
    }
  }
}
