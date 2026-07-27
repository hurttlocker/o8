import { describe, expect, it } from 'vitest';

import type { CodexVoiceCapability } from '@/lib/codex/appserver-probe';
import {
  MANAGED_REALTIME_READY,
  resolveCodexRealtimeTransportAccessWith,
  resolveRealtimeAccessWith,
} from './realtime-access';

function codexCapability(
  input: Partial<CodexVoiceCapability> = {},
): CodexVoiceCapability {
  return {
    checkedAt: 1,
    capable: true,
    whyNot: null,
    installation: {
      installed: true,
      binaryPath: '/fixture/codex',
      version: '0.145.0',
      whyNot: null,
    },
    appServer: {
      reachable: true,
      transports: ['stdio'],
      supportedTransports: ['stdio', 'websocket'],
      realtimeMethods: [
        'thread/realtime/start',
        'thread/realtime/appendAudio',
        'thread/realtime/appendText',
        'thread/realtime/appendSpeech',
        'thread/realtime/stop',
      ],
      missingRealtimeMethods: [],
      whyNot: null,
    },
    auth: {
      mode: 'chatgpt_oauth',
      chatgptOAuth: true,
      authPath: '/fixture/.codex/auth.json',
      whyNot: null,
    },
    realtime: {
      enabled: true,
      featureEnabled: true,
      realtimeSectionPresent: true,
      websocketModeEnabled: true,
      configPath: '/fixture/.codex/config.toml',
      whyNot: null,
    },
    ...input,
  };
}

describe('resolveRealtimeAccessWith', () => {
  it('a BYOK key wins regardless of plan — free for everyone', () => {
    const free = resolveRealtimeAccessWith({ hasByokKey: true, proxyInference: false });
    expect(free.mode).toBe('byok');
    expect(free.available).toBe(true);

    // Even a paid account with a key uses BYOK (their key, their bill).
    const paid = resolveRealtimeAccessWith({ hasByokKey: true, proxyInference: true });
    expect(paid.mode).toBe('byok');
    expect(paid.available).toBe(true);
  });

  it('no key + the paid proxy lever resolves to the managed path', () => {
    const managed = resolveRealtimeAccessWith({ hasByokKey: false, proxyInference: true });
    expect(managed.mode).toBe('managed');
    // Availability tracks whether the managed proxy is actually wired yet.
    expect(managed.available).toBe(MANAGED_REALTIME_READY);
    if (!MANAGED_REALTIME_READY) {
      expect(managed.reason).toMatch(/coming|own OpenAI key/i);
    }
  });

  it('no key + no paid lever is locked (needs a key or an upgrade) — capability not withheld, only cost', () => {
    const locked = resolveRealtimeAccessWith({ hasByokKey: false, proxyInference: false });
    expect(locked.mode).toBe('locked');
    expect(locked.available).toBe(false);
    expect(locked.reason).toMatch(/OpenAI key|upgrade/i);
  });
});

describe('resolveCodexRealtimeTransportAccessWith', () => {
  it('selects the fenced OAuth S2S path only for a fully capable probe', () => {
    expect(resolveCodexRealtimeTransportAccessWith(codexCapability())).toMatchObject({
      mode: 'codex-oauth',
      s2s: true,
      available: true,
    });
  });

  it('automatically falls back to text for an API-key-only app-server', () => {
    const capability = codexCapability({
      capable: false,
      whyNot: 'Connected Voice requires ChatGPT OAuth.',
      auth: {
        mode: 'api_key',
        chatgptOAuth: false,
        authPath: '/fixture/.codex/auth.json',
        whyNot: 'Connected Voice requires ChatGPT OAuth; text fallback remains available.',
      },
    });

    expect(resolveCodexRealtimeTransportAccessWith(capability)).toMatchObject({
      mode: 'text',
      s2s: false,
      available: true,
      reason: expect.stringMatching(/API-key auth.*text automatically/i),
    });
  });

  it('stays unavailable when no local app-server can be reached', () => {
    const capability = codexCapability({
      capable: false,
      whyNot: 'Codex is not installed.',
      installation: {
        installed: false,
        binaryPath: null,
        version: null,
        whyNot: 'Codex is not installed.',
      },
      appServer: {
        reachable: false,
        transports: [],
        supportedTransports: [],
        realtimeMethods: [],
        missingRealtimeMethods: [
          'thread/realtime/start',
          'thread/realtime/appendAudio',
          'thread/realtime/appendText',
          'thread/realtime/appendSpeech',
          'thread/realtime/stop',
        ],
        whyNot: 'Codex is not installed.',
      },
    });

    expect(resolveCodexRealtimeTransportAccessWith(capability)).toMatchObject({
      mode: 'unavailable',
      available: false,
    });
  });

  it('does not claim text fallback when only a Unix daemon is reachable', () => {
    const capability = codexCapability({
      capable: false,
      whyNot: 'Codex app-server realtime methods could not be probed over stdio.',
      appServer: {
        reachable: true,
        transports: ['unix'],
        supportedTransports: ['stdio', 'unix'],
        realtimeMethods: [],
        missingRealtimeMethods: [
          'thread/realtime/start',
          'thread/realtime/appendAudio',
          'thread/realtime/appendText',
          'thread/realtime/appendSpeech',
          'thread/realtime/stop',
        ],
        whyNot: null,
      },
    });

    expect(resolveCodexRealtimeTransportAccessWith(capability)).toMatchObject({
      mode: 'unavailable',
      available: false,
      reason: expect.stringMatching(/requires stdio/i),
    });
  });
});
