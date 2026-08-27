import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export interface AgentVoiceTurnState {
  initialized: boolean;
  lastAssistantId: string | null;
  lastUserId: string | null;
  awaitingReply: boolean;
}

export interface AgentVoiceTurnObservation {
  state: AgentVoiceTurnState;
  speak: { id: string; text: string } | null;
}

export function createAgentVoiceTurnState(): AgentVoiceTurnState {
  return {
    initialized: false,
    lastAssistantId: null,
    lastUserId: null,
    awaitingReply: false,
  };
}

function latestMessage(
  messages: MobileTranscriptEntry[],
  role: 'user' | 'assistant',
  requireText = false,
): MobileTranscriptEntry | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === role && (!requireText || message.text.trim())) return message;
  }
  return null;
}

export function observeAgentVoiceTurn(
  current: AgentVoiceTurnState,
  options: {
    active: boolean;
    busy: boolean;
    enabled: boolean;
    messages: MobileTranscriptEntry[];
  },
): AgentVoiceTurnObservation {
  const latestUser = latestMessage(options.messages, 'user');
  const latestAssistant = latestMessage(options.messages, 'assistant', true);

  if (!current.initialized || !options.active || !options.enabled) {
    return {
      state: {
        initialized: true,
        lastAssistantId: latestAssistant?.id ?? null,
        lastUserId: latestUser?.id ?? null,
        awaitingReply: false,
      },
      speak: null,
    };
  }

  const hasNewUser = Boolean(latestUser && latestUser.id !== current.lastUserId);
  const awaitingReply = current.awaitingReply || hasNewUser;
  const canSpeak = !options.busy
    && awaitingReply
    && Boolean(latestAssistant?.text.trim())
    && latestAssistant?.id !== current.lastAssistantId;

  if (canSpeak && latestAssistant) {
    return {
      state: {
        initialized: true,
        lastAssistantId: latestAssistant.id,
        lastUserId: latestUser?.id ?? current.lastUserId,
        awaitingReply: false,
      },
      speak: { id: latestAssistant.id, text: latestAssistant.text },
    };
  }

  return {
    state: {
      initialized: true,
      lastAssistantId: awaitingReply
        ? current.lastAssistantId
        : latestAssistant?.id ?? current.lastAssistantId,
      lastUserId: latestUser?.id ?? current.lastUserId,
      awaitingReply,
    },
    speak: null,
  };
}
