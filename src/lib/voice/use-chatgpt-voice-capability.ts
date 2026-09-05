'use client';

/**
 * "Voice via your ChatGPT plan" capability — shared client hook (#1620).
 *
 * Fetches src/app/api/voice/chatgpt-capability/route.ts at most once at a time. Two
 * consumers share the cached result: the Founder (Voice) settings row and the fleet
 * narration speaker host — both need the identical "is the paid ChatGPT-plan
 * realtime door open" signal.
 */

import { useEffect, useState } from 'react';
import type { CodexVoiceCapability } from '@/lib/codex/appserver-probe';

export interface ChatgptVoiceCapabilityState {
  status: 'loading' | 'ready' | 'error';
  /** Signed in via ChatGPT OAuth — the "paid ChatGPT plan" signal itself. */
  chatgptOAuth: boolean;
  /** Fully usable right now (install + app-server + auth + realtime feature flag). */
  capable: boolean;
  whyNot: string | null;
}

const INITIAL: ChatgptVoiceCapabilityState = {
  status: 'loading',
  chatgptOAuth: false,
  capable: false,
  whyNot: null,
};

let cachedCapability: ChatgptVoiceCapabilityState | null = null;
let capabilityInFlight: Promise<ChatgptVoiceCapabilityState> | null = null;

export function requestChatgptVoiceCapability(): Promise<ChatgptVoiceCapabilityState> {
  if (cachedCapability) return Promise.resolve(cachedCapability);
  if (!capabilityInFlight) {
    const request = fetch('/api/voice/chatgpt-capability', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; capability?: CodexVoiceCapability } | null) => {
        if (!data?.ok || !data.capability) {
          return { status: 'error', chatgptOAuth: false, capable: false, whyNot: null } as const;
        }
        const state: ChatgptVoiceCapabilityState = {
          status: 'ready',
          chatgptOAuth: data.capability.auth.chatgptOAuth,
          capable: data.capability.capable,
          whyNot: data.capability.whyNot,
        };
        cachedCapability = state;
        return state;
      })
      .catch(() => ({
        status: 'error',
        chatgptOAuth: false,
        capable: false,
        whyNot: null,
      } as const));
    capabilityInFlight = request;
    request.then(
      () => { if (capabilityInFlight === request) capabilityInFlight = null; },
      () => { if (capabilityInFlight === request) capabilityInFlight = null; },
    );
  }
  return capabilityInFlight;
}

export function useChatgptVoiceCapability(
  options: { deferMs?: number } = {},
): ChatgptVoiceCapabilityState {
  const deferMs = options.deferMs ?? 0;
  const [state, setState] = useState<ChatgptVoiceCapabilityState>(cachedCapability ?? INITIAL);

  useEffect(() => {
    let cancelled = false;
    if (cachedCapability) {
      const resolved = cachedCapability;
      void Promise.resolve().then(() => {
        if (!cancelled) setState(resolved);
      });
      return () => { cancelled = true; };
    }
    const load = () => {
      void requestChatgptVoiceCapability().then((next) => {
        if (!cancelled) setState(next);
      });
    };
    const timer = deferMs > 0 ? window.setTimeout(load, deferMs) : null;
    if (timer === null) load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [deferMs]);

  return state;
}
