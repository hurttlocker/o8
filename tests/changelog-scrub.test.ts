/**
 * #2516 — the public changelog scrub, through the real script.
 *
 * Real-path doctrine: this drives `scripts/sync-public-changelog.sh` itself in
 * its `--scrub-only` mode, so the assertions run against the substitution list
 * the ship pipeline actually publishes with. Asserting a copy of the patterns
 * here would pass while the script kept publishing broken words.
 *
 * The defect this pins: a pattern that matches only part of a name leaves the
 * rest glued to the replacement. `ChatGPT` published as `ChatAI model` and
 * `gpt-live-1` as `AI modellive-1`, and the weekly digest builds its copy from
 * this changelog, so the break reached a marketing email.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', 'scripts', 'sync-public-changelog.sh');

function scrub(subjects: readonly string[]): string[] {
  const out = execFileSync('bash', [SCRIPT, '--scrub-only'], {
    input: `${subjects.join('\n')}\n`,
    encoding: 'utf8',
  });
  return out.split('\n').slice(0, subjects.length);
}

describe('public changelog scrub', () => {
  it('replaces a model name whole, whatever its prefix or suffix', () => {
    const [live, chat, realtime, numbered, unhyphenated] = scrub([
      'feat: admit gpt-live-1 behind a delegated phone Code variant',
      'feat(voice): "Voice via your ChatGPT plan" settings row',
      'feat(voice): expose all 10 GPT-realtime voices',
      'feat: pin GPT-5.6 for the worker seat',
      'feat: pin gpt4o for the cheap seat',
    ]);
    expect(live).toBe('feat: admit AI model behind a delegated phone Code variant');
    expect(chat).toBe('feat(voice): "Voice via your AI model plan" settings row');
    expect(realtime).toBe('feat(voice): expose all 10 AI model voices');
    expect(numbered).toBe('feat: pin AI model for the worker seat');
    // A suffix with no hyphen glued too, and is the case the first fix missed.
    expect(unhyphenated).toBe('feat: pin AI model for the cheap seat');
  });

  it('leaves no glued word behind for any replacement it makes', () => {
    const replacements = ['AI model', 'AI provider', 'agent runtime', 'voice agent', 'competing product'];
    const scrubbed = scrub([
      'feat: admit gpt-live-1 behind a delegated phone Code variant',
      'feat(voice): "Voice via your ChatGPT plan" settings row',
      'feat: pin gpt4o for the cheap seat',
      'feat: Claude Code sessions resume after a reload',
      'feat: Symon hears the fleet at session start',
    ]);
    for (const line of scrubbed) {
      for (const replacement of replacements) {
        // A replacement must be preceded and followed by a boundary, never by
        // the leftover half of the name it replaced.
        expect(line).not.toMatch(new RegExp(`\\w${replacement}|${replacement}\\w`));
      }
    }
  });

  it('passes a subject with no internal name through byte-identical', () => {
    const subject = 'feat: the merge preview lists every changed file with its review state';
    expect(scrub([subject])[0]).toBe(subject);
  });
});
