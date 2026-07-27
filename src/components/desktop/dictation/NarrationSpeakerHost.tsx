'use client';

/**
 * NarrationSpeakerHost — the fleet narration speaker (#1620 — voice slice).
 *
 * Headless, mounted once at the dashboard level (alongside RealtimeVoiceHost).
 * Long-polls GET /api/voice/narration (src/app/api/voice/narration/route.ts,
 * already on main) and voices each budget-approved `spoken` decision.
 *
 * Dormant by default, two independent gates:
 *   - Server: the poll returns `enabled: false` until O8_VOICE_NARRATION is
 *     set (fleet-narration-bridge.ts) — this host just backs off and re-polls.
 *   - Client: only runs once useChatgptVoiceCapability() confirms a paid
 *     ChatGPT plan (Codex OAuth) is signed in — the same gate the Settings →
 *     Voice row uses, so free-tier / Apple-dictation / BYOK-only users see no
 *     behavior change at all.
 *
 * Voicing mechanism: RealtimeSessionHandle (src/lib/voice/realtime-client.ts,
 * transport-lane-owned, not modified here) exposes no way to inject arbitrary
 * text into a live gpt-realtime session, and there is no Rust bridge for that
 * either. This host instead drives the existing native Symon TTS callouts
 * (tts_speak / symon_speak_status) — symon_speak_status already implements
 * the exact "queue behind a pause, never interrupt" semantics
 * (tts::playback::play_status_queued) that ambient/on-demand decisions need,
 * with zero new Rust plumbing. `interrupt-now` decisions stop any current
 * playback first so they truly interrupt.
 */

import { useEffect } from 'react';
import { isTauri, ttsSpeak, ttsStop, symonSpeakStatus } from '@/lib/tauri/bridge';
import { useChatgptVoiceCapability } from '@/lib/voice/use-chatgpt-voice-capability';
import { planNarrationSpeech, type NarrationSpeechAction } from '@/lib/voice/narration-speaker';
import type { NarrationDecision } from '@/lib/voice/narration-policy';

const LOG = '[narration-speaker]';
const POLL_TIMEOUT_MS = 20_000;
const DISABLED_BACKOFF_MS = 30_000;
const ERROR_BACKOFF_MS = 8_000;
const AMBIENT_CADENCE_MS = 90_000;

interface NarrationPollResponse {
  ok: boolean;
  enabled: boolean;
  nextSince: number;
  spoken: NarrationDecision[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function speakAction(action: NarrationSpeechAction): Promise<void> {
  try {
    if (action.mode === 'interrupt') {
      await ttsStop();
      await ttsSpeak(action.utterance);
    } else {
      await symonSpeakStatus(action.utterance);
    }
  } catch (error) {
    console.warn(`${LOG} speak failed:`, error);
  }
}

export function NarrationSpeakerHost() {
  const capability = useChatgptVoiceCapability();

  useEffect(() => {
    if (!isTauri()) return;
    if (capability.status !== 'ready' || !capability.chatgptOAuth) return;

    let cancelled = false;
    let since = 0;
    let lastAmbientAt = 0;

    const pollOnce = async (): Promise<void> => {
      const ambientDue = Date.now() - lastAmbientAt > AMBIENT_CADENCE_MS;
      const params = new URLSearchParams({
        since: String(since),
        timeoutMs: String(POLL_TIMEOUT_MS),
        ...(ambientDue ? { ambient: '1' } : {}),
      });

      let response: Response;
      try {
        response = await fetch(`/api/voice/narration?${params.toString()}`, { credentials: 'same-origin' });
      } catch (error) {
        console.warn(`${LOG} poll failed:`, error);
        await sleep(ERROR_BACKOFF_MS);
        return;
      }
      if (!response.ok) {
        await sleep(ERROR_BACKOFF_MS);
        return;
      }

      const data = await response.json().catch(() => null) as NarrationPollResponse | null;
      if (!data?.ok) {
        await sleep(ERROR_BACKOFF_MS);
        return;
      }
      if (ambientDue) lastAmbientAt = Date.now();
      if (Number.isFinite(data.nextSince)) since = data.nextSince;

      if (!data.enabled) {
        await sleep(DISABLED_BACKOFF_MS);
        return;
      }

      for (const action of planNarrationSpeech(data.spoken ?? [])) {
        if (cancelled) return;
        await speakAction(action);
      }
    };

    void (async () => {
      while (!cancelled) {
        await pollOnce();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [capability.status, capability.chatgptOAuth]);

  return null;
}
