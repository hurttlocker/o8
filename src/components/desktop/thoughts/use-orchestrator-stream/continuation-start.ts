import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { formatTimestampLabel } from './shared';
import type { CurrentAssistantStreamState } from './socket';

const VERBATIM_STREAM_BACKENDS = new Set(['o8', 'acp', 'hermes', 'opencode']);

export function createAssistantState(
  resetEpochRef: { current: number },
  assistantMessageId?: unknown,
  backend?: unknown,
  model?: unknown,
): CurrentAssistantStreamState {
  return {
    id: typeof assistantMessageId === 'string' && assistantMessageId.trim()
      ? assistantMessageId.trim()
      : `assistant-${Date.now()}`,
    chunks: [],
    thinkingChunks: [],
    epoch: resetEpochRef.current,
    backend: isOrchestratorBackendId(backend) ? backend : undefined,
    model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
    verbatimStream: typeof backend === 'string' && VERBATIM_STREAM_BACKENDS.has(backend),
  };
}

/** Server-originated turns need the same visible boundary as a local send. */
export function continuationUserMessage(data?: Record<string, unknown>): MobileTranscriptEntry | null {
  if (typeof data?.userMessageId !== 'string' || !data.userMessageId
    || typeof data.assistantMessageId !== 'string' || !data.assistantMessageId
    || typeof data.message !== 'string' || typeof data.timestamp !== 'number'
    || !Number.isFinite(data.timestamp)) return null;
  return { id: data.userMessageId, role: 'user', text: data.message,
    media: Array.isArray(data.media) ? data.media.filter((item): item is NonNullable<MobileTranscriptEntry['media']>[number] =>
      item && typeof item === 'object' && ['image', 'pdf', 'file'].includes(item.kind)
      && typeof item.path === 'string' && typeof item.name === 'string'
      && (item.mimeType === undefined || typeof item.mimeType === 'string')) : undefined,
    timestamp: data.timestamp, timestampLabel: formatTimestampLabel(data.timestamp) };
}
