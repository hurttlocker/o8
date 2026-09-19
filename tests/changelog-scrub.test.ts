/**
 * The public changelog scrub, through the real script.
 *
 * Real-path doctrine: this drives `scripts/sync-public-changelog.sh` itself in
 * its `--scrub-only` mode, so the assertions run against the substitution list
 * the ship pipeline actually publishes with. Asserting a copy of the patterns
 * here would pass while the script kept publishing the wrong thing.
 *
 * Two properties are pinned. Vendor, framework and model names publish
 * unchanged, because the repository names them all openly (#2516). Internal
 * project names are still replaced, and replaced WHOLE: a pattern that matches
 * part of a name leaves the rest glued to the replacement, which is how
 * `ChatGPT` once published as `ChatAI model` and `gpt-realtime-2.1-mini` as
 * `AI model-mini`. The weekly digest builds its copy from this changelog, so a
 * broken word ships as marketing copy.
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

// Every replacement the script can still emit. A replacement sitting next to a
// word character or a hyphenated remainder means a name was cut in half.
const REPLACEMENTS = ['o8', 'voice agent', 'design system', 'the voice stack', 'agent runtime', 'bundled runtime', 'context-aware', 'client', 'project rules', 'memory'];

describe('public changelog scrub', () => {
  it('publishes vendor, framework and model names unchanged', () => {
    // Every one of these is named openly in the repository. The model names in
    // particular are the shapes that used to break: a prefix, a hyphenated
    // suffix, a dotted version, and a dotted version followed by another
    // segment, which published as "AI model-mini".
    const subjects = [
      'feat: pin gpt-realtime-2.1-mini for the voice seat',
      'feat: pin GPT-5.6-sol for the worker seat',
      'feat(voice): "Voice via your ChatGPT plan" settings row',
      'feat(runtime): Claude Code sessions resume after a reload',
      'feat: Codex workers report progress through the packet CLI',
      'feat: Tauri sidecar picks a free port before spawning the server',
      'feat: bring your own API key on every plan',
      'feat: the Cursor adapter discovers sessions read-only',
    ];
    expect(scrub(subjects)).toEqual(subjects);
  });

  it('replaces an internal name whole, leaving nothing glued to it', () => {
    const [symon, cortex, claw] = scrub([
      'feat: Symon hears the fleet at session start',
      'feat: Cortex ingests the repo spec at connect',
      'feat: OpenClaw dispatches through the operator surface',
    ]);
    expect(symon).toBe('feat: voice agent hears the fleet at session start');
    expect(cortex).toBe('feat: o8 ingests the repo spec at connect');
    expect(claw).toBe('feat: agent runtime dispatches through the operator surface');

    for (const line of [symon, cortex, claw]) {
      for (const replacement of REPLACEMENTS) {
        // A hyphen counts as glue too. `\w` alone misses `AI model-mini`,
        // which is how that defect survived a green suite once already.
        expect(line).not.toMatch(new RegExp(`[\\w-]${replacement}|${replacement}[\\w-]`));
      }
    }
  });

  it('passes a subject with no internal name through byte-identical', () => {
    const subject = 'feat: the merge preview lists every changed file with its review state';
    expect(scrub([subject])[0]).toBe(subject);
  });

  it('scrubs a final line that arrives without a trailing newline', () => {
    const out = execFileSync('bash', [SCRIPT, '--scrub-only'], {
      input: 'feat: Symon speaks the briefing',
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('feat: voice agent speaks the briefing');
  });
});
