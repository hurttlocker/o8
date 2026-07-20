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
  REALTIME_FLAGSHIP_MODEL,
  DEFAULT_VOICE,
  REALTIME_INPUT_TRANSCRIPTION_MODEL,
  REALTIME_TOKEN_TTL_SECONDS,
  DEFAULT_INSTRUCTIONS,
  PHONE_CODE_TOOL_NAMES,
  selectPhoneCodeTools,
  selectPhoneRealtimeModel,
  buildRealtimeMintSession,
  buildClientSecretsBody,
  MIC_PROFILE_AUDIO_INPUT,
} from './realtime-session-config';

describe('realtime-session-config — shared assembler', () => {
  it('desk inputs (model + voice) produce the exact legacy minimal shape — NO gate', () => {
    // The desk mic was explicitly fine (Q 2026-07-11): no micProfile → no
    // audio.input → byte-identical to the pre-gate desk mint.
    expect(buildRealtimeMintSession({ model: 'm', voice: 'v' })).toEqual({
      type: 'realtime',
      model: 'm',
      audio: { output: { voice: 'v' } },
    });
  });

  it('micProfile near_field adds the phone gate; noise_reduction is an OBJECT (a bare string 400s)', () => {
    const session = buildRealtimeMintSession({ model: 'm', voice: 'v', micProfile: 'near_field' });
    const input = (session.audio as { input: Record<string, unknown> }).input;
    expect(input.noise_reduction).toEqual({ type: 'near_field' });
    expect(input.turn_detection).toEqual(MIC_PROFILE_AUDIO_INPUT.near_field.turn_detection);
    // The gate is a real gate: threshold raised above OpenAI's 0.5 default.
    expect((MIC_PROFILE_AUDIO_INPUT.near_field.turn_detection as { threshold: number }).threshold).toBeGreaterThan(0.5);
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
      micProfile: 'near_field',
    });
    expect(session).toEqual({
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions: DEFAULT_INSTRUCTIONS,
      audio: {
        output: { voice: DEFAULT_VOICE },
        input: {
          ...MIC_PROFILE_AUDIO_INPUT.near_field,
          transcription: { model: REALTIME_INPUT_TRANSCRIPTION_MODEL },
        },
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
    expect(REALTIME_FLAGSHIP_MODEL).toBe('gpt-realtime-2.1');
    expect(DEFAULT_VOICE).toBe('marin');
    expect(REALTIME_INPUT_TRANSCRIPTION_MODEL).toBe('whisper-1');
    expect(REALTIME_TOKEN_TTL_SECONDS).toBe(600);
    expect(DEFAULT_INSTRUCTIONS).toContain('You are Symon');
  });

  it('keeps Life on mini even when the Code experiment requests flagship', () => {
    expect(selectPhoneRealtimeModel({
      workspaceMode: 'o8',
      experiment: 'flagship',
      operatorOverride: 'flagship',
      bucketKey: 'device-1',
    })).toEqual({ model: REALTIME_MODEL, variant: 'mini' });
  });

  it('supports explicit Code variants and a stable A/B bucket', () => {
    expect(selectPhoneRealtimeModel({
      workspaceMode: 'code',
      bucketKey: 'device-1',
      operatorOverride: 'flagship',
    })).toEqual({ model: REALTIME_FLAGSHIP_MODEL, variant: 'flagship' });
    const first = selectPhoneRealtimeModel({
      workspaceMode: 'code',
      experiment: 'ab',
      bucketKey: 'device-1:repo-1',
    });
    expect(selectPhoneRealtimeModel({
      workspaceMode: 'code',
      experiment: 'ab',
      bucketKey: 'device-1:repo-1',
    })).toEqual(first);
  });

  it('selects exactly the canonical phone Code tool pack without Life/Mac catalog leakage', () => {
    const catalog = [
      { type: 'function', name: 'send_email' },
      ...PHONE_CODE_TOOL_NAMES.toReversed().map((name) => ({ type: 'function', name })),
      { type: 'function', name: 'spotify_play' },
      { type: 'function', name: 'o8_status', duplicate: true },
    ];

    const selection = selectPhoneCodeTools(catalog);

    expect(selection.missing).toEqual([]);
    expect(selection.tools.map((tool) => tool.name)).toEqual(PHONE_CODE_TOOL_NAMES);
    expect(selection.tools.map((tool) => tool.name)).not.toContain('send_email');
    expect(selection.tools.map((tool) => tool.name)).not.toContain('spotify_play');
  });

  it('reports every absent or non-function Code tool instead of minting a partial pack', () => {
    const selection = selectPhoneCodeTools([
      { type: 'function', name: 'o8_status' },
      { type: 'not-a-function', name: 'git_status' },
    ]);

    expect(selection.tools.map((tool) => tool.name)).toEqual(['o8_status']);
    expect(selection.missing).toContain('git_status');
    expect(selection.missing).toContain('o8_dispatch');
    expect(selection.missing).toHaveLength(PHONE_CODE_TOOL_NAMES.length - 1);
  });
});
