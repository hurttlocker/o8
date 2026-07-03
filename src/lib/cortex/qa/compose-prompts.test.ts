import { describe, expect, it } from 'vitest';

import {
  buildFlashComposePrompt,
  buildSonnetComposeSystem,
} from '@/lib/cortex/qa/compose-prompts';

describe('compose prompt verbosity', () => {
  it('keeps the default Flash compose contract full-sized', () => {
    const prompt = buildFlashComposePrompt('What changed?', '[]');

    expect(prompt).toContain('Answer concisely (1-2 sentences)');
    expect(prompt).not.toContain('<=150 tokens');
    expect(prompt).not.toContain('at most 2 citations total');
  });

  it('adds the terse Flash compose contract when requested', () => {
    const prompt = buildFlashComposePrompt('What changed?', '[]', { terse: true });

    expect(prompt).toContain('Answer in <=150 tokens with no preamble');
    expect(prompt).toContain('at most 2 citations total');
    expect(prompt).toContain('choose the two strongest sources');
  });

  it('adds the terse Sonnet compose contract only when requested', () => {
    const full = buildSonnetComposeSystem();
    const terse = buildSonnetComposeSystem({ terse: true });

    expect(full).not.toContain('<=150 tokens');
    expect(terse).toContain('answer in <=150 tokens');
    expect(terse).toContain('at most 2 citations total');
    expect(terse).toContain('no preamble');
  });
});
