import { useEffect, useRef } from 'react';
import type { AgentSetupRequest } from '@/lib/setup/agent-request';
import type { OnboardingRequest } from './request';

/** Poll only while onboarding is visible; an absent window leaves an honest pending receipt. */
export function useAgentSetupRequest(request: OnboardingRequest, receive: (value: AgentSetupRequest) => Promise<void>) {
  const receiveRef = useRef(receive);
  useEffect(() => { receiveRef.current = receive; });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await request('/api/setup/agent?view=request', { cache: 'no-store' });
        if (response.ok) {
          const data = await response.json() as { request?: AgentSetupRequest };
          if (!cancelled && data.request?.status === 'pending') await receiveRef.current(data.request);
        }
      } catch { /* A server restart retains the durable request for the next poll. */ }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [request]);
}
