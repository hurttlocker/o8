'use client';

import { useEffect, useState } from 'react';
import type { AgentMessage, AgentPresence } from '@/lib/agents/types';
import { isOperatorWindowVisible } from '@/lib/tauri/window-visibility';

const POLL_MS = 15_000;

export function selectPeerMessages(messages: AgentMessage[], self: AgentPresence): AgentMessage[] {
  const name = self.name.toLocaleLowerCase();
  return messages.filter((message) => message.repo === self.repo
    && (message.from.toLocaleLowerCase() === name || message.to.toLocaleLowerCase() === name));
}

function matchesSession(presence: AgentPresence, sessionKey: string): boolean {
  return presence.sessionKey === sessionKey
    || presence.agentId === `session:${sessionKey}`
    || presence.sessionKey === `${presence.runtime}:${sessionKey}`;
}

export function useAgentPeerMessages(sessionKey: string): {
  self: AgentPresence | null;
  messages: AgentMessage[];
} {
  const [exchange, setExchange] = useState<{
    sessionKey: string;
    self: AgentPresence;
    messages: AgentMessage[];
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        if (!await isOperatorWindowVisible() || controller.signal.aborted) return;
        const presenceResponse = await fetch('/api/agents/presence?scope=stored', {
          signal: controller.signal, cache: 'no-store',
        });
        if (!presenceResponse.ok) return;
        const presenceBody = await presenceResponse.json() as { agents?: AgentPresence[] };
        const matched = presenceBody.agents?.find((agent) => matchesSession(agent, sessionKey));
        if (!matched || controller.signal.aborted) return;
        const messageResponse = await fetch(`/api/agents/message?repo=${encodeURIComponent(matched.repo)}&limit=50`, {
          signal: controller.signal, cache: 'no-store',
        });
        if (!messageResponse.ok) return;
        const messageBody = await messageResponse.json() as { messages?: AgentMessage[] };
        if (controller.signal.aborted) return;
        setExchange({
          sessionKey,
          self: matched,
          messages: selectPeerMessages(messageBody.messages ?? [], matched),
        });
      } catch {
        // Keep the last known exchange while the local control plane reconnects.
      } finally {
        inFlight = false;
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), POLL_MS);
    const onReconcile = () => { void load(); };
    window.addEventListener('o8:lifecycle-reconcile', onReconcile);
    window.addEventListener('focus', onReconcile);
    document.addEventListener('visibilitychange', onReconcile);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('o8:lifecycle-reconcile', onReconcile);
      window.removeEventListener('focus', onReconcile);
      document.removeEventListener('visibilitychange', onReconcile);
    };
  }, [sessionKey]);

  return exchange?.sessionKey === sessionKey
    ? { self: exchange.self, messages: exchange.messages }
    : { self: null, messages: [] };
}
