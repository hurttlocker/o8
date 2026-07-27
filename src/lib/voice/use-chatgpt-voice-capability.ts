'use client';

/**
 * "Voice via your ChatGPT plan" capability — shared client hook (#1620).
 *
 * Fetches src/app/api/voice/chatgpt-capability/route.ts once on mount. Two
 * consumers share this: the Founder (Voice) settings row and the fleet
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

export function useChatgptVoiceCapability(): ChatgptVoiceCapabilityState {
  const [state, setState] = useState<ChatgptVoiceCapabilityState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice/chatgpt-capability', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean; capability?: CodexVoiceCapability } | null) => {
        if (cancelled) return;
        if (d?.ok && d.capability) {
          setState({
            status: 'ready',
            chatgptOAuth: d.capability.auth.chatgptOAuth,
            capable: d.capability.capable,
            whyNot: d.capability.whyNot,
          });
        } else {
          setState({ status: 'error', chatgptOAuth: false, capable: false, whyNot: null });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', chatgptOAuth: false, capable: false, whyNot: null });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
