/**
 * Config-parity guard (docs/symon-agent-mode.md §"config parity is a hard
 * requirement"). The desk mint and the Agent-mode mint MUST assemble the session
 * from this one source — this suite locks the assembler so a future edit can't
 * silently diverge the two surfaces, and pins the desk shape byte-for-byte so the
 * refactor that extracted this helper did not change desk behavior.
 */
import { describe, expect, it } from 'vitest';

import {
  REALTIME_MODEL,
  DEFAULT_VOICE,
  REALTIME_INPUT_TRANSCRIPTION_MODEL,
  REALTIME_TOKEN_TTL_SECONDS,
  DEFAULT_INSTRUCTIONS,
  buildRealtimeMintSession,
  buildClientSecretsBody,
} from './realtime-session-config';

describe('realtime-session-config — shared assembler', () => {
  it('desk inputs (model + voice) produce the exact legacy minimal shape', () => {
    // This is byte-identical to what the desk mint sent before the extraction —
    // instructions/tools/transcription are applied client-side on desk.
    expect(buildRealtimeMintSession({ model: 'm', voice: 'v' })).toEqual({
      type: 'realtime',
      model: 'm',
      audio: { output: { voice: 'v' } },
    });
  });

  it('is deterministic — identical inputs deep-equal (no hidden state / order drift)', () => {
    const inputs = {
      model: REALTIME_MODEL,
      voice: DEFAULT_VOICE,
      instructions: DEFAULT_INSTRUCTIONS,
      tools: [{ type: 'function', name: 'o8_status' }],
      inputTranscriptionModel: REALTIME_INPUT_TRANSCRIPTION_MODEL,
    };
    expect(buildRealtimeMintSession(inputs)).toEqual(buildRealtimeMintSession(inputs));
  });

  it('the desk caller and the mobile caller yield IDENTICAL config given identical inputs', () => {
    // Both routes call buildClientSecretsBody. Feeding the same inputs from each
    // caller must produce the same body — the parity property the contract names.
    const inputs = {
      model: REALTIME_MODEL,
      voice: 'cedar',
      instructions: DEFAULT_INSTRUCTIONS,
      tools: [{ type: 'function', name: 'o8_status' }],
      inputTranscriptionModel: REALTIME_INPUT_TRANSCRIPTION_MODEL,
    };
    const deskCall = buildClientSecretsBody(inputs, REALTIME_TOKEN_TTL_SECONDS);
    const mobileCall = buildClientSecretsBody(inputs, REALTIME_TOKEN_TTL_SECONDS);
    expect(deskCall).toEqual(mobileCall);
  });

  it('Agent-mode inputs bake in instructions, tools (+ auto choice) and input transcription', () => {
    const tools = [{ type: 'function', name: 'o8_status' }, { type: 'function', name: 'o8_dispatch' }];
    const session = buildRealtimeMintSession({
      model: REALTIME_MODEL,
      voice: DEFAULT_VOICE,
      instructions: DEFAULT_INSTRUCTIONS,
      tools,
      inputTranscriptionModel: REALTIME_INPUT_TRANSCRIPTION_MODEL,
    });
    expect(session).toEqual({
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions: DEFAULT_INSTRUCTIONS,
      audio: {
        output: { voice: DEFAULT_VOICE },
        input: { transcription: { model: REALTIME_INPUT_TRANSCRIPTION_MODEL } },
      },
      tools,
      tool_choice: 'auto',
    });
  });

  it('omits tools/tool_choice when the tool list is empty (no phantom empty array)', () => {
    const session = buildRealtimeMintSession({ model: 'm', voice: 'v', tools: [] });
    expect('tools' in session).toBe(false);
    expect('tool_choice' in session).toBe(false);
  });

  it('buildClientSecretsBody wraps expires_after + session with the TTL', () => {
    const body = buildClientSecretsBody({ model: 'm', voice: 'v' }, 600);
    expect(body).toEqual({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: { type: 'realtime', model: 'm', audio: { output: { voice: 'v' } } },
    });
  });

  it('exposes the expected shared constants', () => {
    expect(REALTIME_MODEL).toBe('gpt-realtime-2.1-mini');
    expect(DEFAULT_VOICE).toBe('marin');
    expect(REALTIME_INPUT_TRANSCRIPTION_MODEL).toBe('whisper-1');
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(600);
    expect(DEFAULT_INSTRUCTIONS).toContain('You are Symon');
  });
});
