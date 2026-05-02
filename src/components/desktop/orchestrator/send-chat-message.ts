import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ChatModelOption } from './chat-models';

function timestampLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export async function sendChatMessage(message: string, modelChoice: ChatModelOption): Promise<MobileTranscriptEntry[]> {
  const timestamp = Date.now();
  return [
    {
      id: `local-chat-user-${timestamp}`,
      role: 'user',
      text: message,
      timestamp,
      timestampLabel: timestampLabel(timestamp),
    },
    {
      id: `local-chat-assistant-${timestamp}`,
      role: 'assistant',
      text: `Chat mode shipped — backend coming soon. (Selected model: ${modelChoice.label})`,
      timestamp: timestamp + 1,
      timestampLabel: timestampLabel(timestamp + 1),
      model: modelChoice.label,
    },
  ];
}
