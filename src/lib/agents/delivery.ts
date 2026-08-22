import 'server-only';

import type { AgentMessage, AgentPresence } from './store';

export interface AgentUserRolePayload {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
}

export interface AgentMessageDeliverySeams {
  sendClaude: (target: AgentPresence, payload: AgentUserRolePayload) => Promise<void>;
  sendCodex: (target: AgentPresence, text: string) => Promise<void>;
}

export function nativeAgentMessageText(message: AgentMessage): string {
  return `[o8 message from ${message.from}]\n\n${message.text}`;
}

export function buildAgentUserRolePayload(message: AgentMessage): AgentUserRolePayload {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: nativeAgentMessageText(message),
    },
  };
}

async function defaultSendClaude(target: AgentPresence, payload: AgentUserRolePayload): Promise<void> {
  if (!target.sessionKey || !target.worktreePath) throw new Error('Claude session metadata is incomplete.');
  const { ensureSession, sendMessage } = await import('@/lib/claude-code/interactive-session');
  const session = ensureSession(
    `agent-message:${target.agentId}`,
    target.worktreePath,
    undefined,
    'acceptEdits',
    target.sessionKey,
  );
  void sendMessage(session, payload.message.content, () => {}).catch((error) => {
    console.error('[agent-message] Claude native delivery failed:', error);
  });
}

async function defaultSendCodex(target: AgentPresence, text: string): Promise<void> {
  if (!target.sessionKey) throw new Error('Codex thread metadata is incomplete.');
  const { getRuntime } = await import('@/lib/runtimes');
  const runtime = getRuntime('codex');
  if (!runtime) throw new Error('Codex runtime is unavailable.');
  void runtime.resume(target.sessionKey, text).then((result) => {
    if (!result.ok) console.error('[agent-message] Codex native delivery refused:', result.note);
  }).catch((error) => {
    console.error('[agent-message] Codex native delivery failed:', error);
  });
}

export const defaultAgentMessageDeliverySeams: AgentMessageDeliverySeams = {
  sendClaude: defaultSendClaude,
  sendCodex: defaultSendCodex,
};

export async function deliverAgentMessage(
  message: AgentMessage,
  target: AgentPresence,
  seams: AgentMessageDeliverySeams = defaultAgentMessageDeliverySeams,
): Promise<{ delivery: AgentMessage['delivery']; note: string }> {
  if (!target.sessionKey) return { delivery: 'poll', note: 'Target polls the durable inbox.' };
  if (target.runtime === 'claude' || target.runtime === 'claude-code') {
    await seams.sendClaude(target, buildAgentUserRolePayload(message));
    return { delivery: 'native', note: 'Queued on the Claude user-role session path.' };
  }
  if (target.runtime === 'codex') {
    const text = nativeAgentMessageText(message);
    await seams.sendCodex(target, text);
    return { delivery: 'native', note: 'Queued through Codex thread resume.' };
  }
  return { delivery: 'poll', note: 'Target runtime polls the durable inbox.' };
}
