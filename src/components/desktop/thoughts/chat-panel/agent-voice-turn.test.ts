import { describe, expect, it } from 'vitest';

import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  createAgentVoiceTurnState,
  observeAgentVoiceTurn,
} from './agent-voice-turn';

function message(id: string, role: 'user' | 'assistant', text: string): MobileTranscriptEntry {
  return { id, role, text };
}

describe('agent voice turn state', () => {
  it('baselines restored history without speaking it', () => {
    const observed = observeAgentVoiceTurn(createAgentVoiceTurnState(), {
      active: true,
      busy: false,
      enabled: true,
      messages: [message('u1', 'user', 'old prompt'), message('a1', 'assistant', 'old reply')],
    });

    expect(observed.speak).toBeNull();
    expect(observed.state.lastAssistantId).toBe('a1');
    expect(observed.state.awaitingReply).toBe(false);
  });

  it('speaks one settled reply after a new operator turn', () => {
    const baseline = observeAgentVoiceTurn(createAgentVoiceTurnState(), {
      active: true,
      busy: false,
      enabled: true,
      messages: [],
    }).state;
    const waiting = observeAgentVoiceTurn(baseline, {
      active: true,
      busy: true,
      enabled: true,
      messages: [message('u2', 'user', 'new prompt'), message('a2', 'assistant', 'partial')],
    });

    expect(waiting.speak).toBeNull();
    expect(waiting.state.awaitingReply).toBe(true);

    const settled = observeAgentVoiceTurn(waiting.state, {
      active: true,
      busy: false,
      enabled: true,
      messages: [message('u2', 'user', 'new prompt'), message('a2', 'assistant', 'complete reply')],
    });

    expect(settled.speak).toEqual({ id: 'a2', text: 'complete reply' });
    expect(settled.state.awaitingReply).toBe(false);

    const duplicate = observeAgentVoiceTurn(settled.state, {
      active: true,
      busy: false,
      enabled: true,
      messages: [message('u2', 'user', 'new prompt'), message('a2', 'assistant', 'complete reply')],
    });
    expect(duplicate.speak).toBeNull();
  });

  it('does not speak turns that settle while the surface is inactive or disabled', () => {
    const baseline = observeAgentVoiceTurn(createAgentVoiceTurnState(), {
      active: true,
      busy: false,
      enabled: true,
      messages: [],
    }).state;
    const waiting = observeAgentVoiceTurn(baseline, {
      active: true,
      busy: true,
      enabled: true,
      messages: [message('u3', 'user', 'prompt')],
    }).state;

    const inactive = observeAgentVoiceTurn(waiting, {
      active: false,
      busy: false,
      enabled: true,
      messages: [message('u3', 'user', 'prompt'), message('a3', 'assistant', 'reply')],
    });
    expect(inactive.speak).toBeNull();
    expect(inactive.state.awaitingReply).toBe(false);

    const disabled = observeAgentVoiceTurn(inactive.state, {
      active: true,
      busy: false,
      enabled: false,
      messages: [message('u4', 'user', 'another'), message('a4', 'assistant', 'another reply')],
    });
    expect(disabled.speak).toBeNull();
  });
});
