import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceFlowState } from './OnboardingReposStep';
import type { OnboardingRequest } from './request';
export function useOnboardingGithub(request: OnboardingRequest, openExternal: (url: string) => void) {
  const [githubFlow, setGithubFlow] = useState<DeviceFlowState>({ stage: 'idle' });
  const [githubDeviceFlowEnabled, setGithubDeviceFlowEnabled] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flowIdRef = useRef<string | null>(null);
  useEffect(() => () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); }, []);
  useEffect(() => {
    let active = true;
    void request('/api/panel/github-status').then(r => r.ok ? r.json() : null)
      .then(status => { if (active) setGithubDeviceFlowEnabled(Boolean(status?.deviceFlowEnabled)); })
      .catch(() => { if (active) setGithubDeviceFlowEnabled(false); });
    return () => { active = false; };
  }, [request]);
  // ── GitHub auth ──
  const csrfTokenRef = useRef<string | null>(null);
  // Hard-cap device-code polling so a wedged endpoint (persistent 5xx/429,
  // network silently dropping requests) can't leak the interval forever.
  // 5s interval × 120 attempts = 10 min — matches GitHub's device flow expiry.
  const pollAttemptsRef = useRef(0);
  const MAX_POLL_ATTEMPTS = 120;
  const startGithubFlow = useCallback(async (onSuccess?: () => void) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    setGithubFlow({ stage: 'waiting' });
    pollAttemptsRef.current = 0;
    try {
      const res = await request('/api/panel/github-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setGithubFlow({ stage: 'error', error: d.error || `Auth failed (${res.status})` });
        return;
      }
      const d = await res.json();
      flowIdRef.current = d.flowId;
      csrfTokenRef.current = d.csrfToken ?? null;
      setGithubFlow({ stage: 'polling', userCode: d.userCode, verificationUrl: d.verificationUriComplete || d.verificationUri });
      if (d.verificationUriComplete || d.verificationUri) openExternal(d.verificationUriComplete || d.verificationUri);
      pollTimerRef.current = setInterval(async () => {
        if (!flowIdRef.current) return;
        pollAttemptsRef.current += 1;
        if (pollAttemptsRef.current > MAX_POLL_ATTEMPTS) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setGithubFlow({ stage: 'error', error: 'Authorization timed out. Try again.' });
          return;
        }
        try {
          const pr = await request('/api/panel/github-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', flowId: flowIdRef.current, csrfToken: csrfTokenRef.current }) });
          if (!pr.ok) return;
          const pd = await pr.json();
          if (pd.status === 'complete') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setGithubFlow({ stage: 'success' });
            // Refresh the optional project list after the external sign-in.
            onSuccess?.();
          } else if (pd.status === 'expired' || pd.error) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setGithubFlow({ stage: 'error', error: pd.error || 'Expired. Try again.' });
          }
        } catch { /* keep polling — but the attempt counter still ticks, so we'll bail at the cap */ }
      }, 5000);
    } catch {
      setGithubFlow({ stage: 'error', error: 'Network error.' });
    }
  }, [openExternal, request]);

  return { githubFlow, githubDeviceFlowEnabled, startGithubFlow };
}
