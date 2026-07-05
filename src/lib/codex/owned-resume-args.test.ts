import { describe, expect, it } from 'vitest';
import { codexResumeArgs } from './owned';

// `codex exec resume` rejects `-s` (exit 2 before the turn starts) — unlike
// `codex exec`, it has no sandbox short flag. Live-hit 2026-07-05: every
// steer-resume failed silently because the seam test mocked the runtime and
// never validated the real argv contract.
describe('codexResumeArgs — codex exec resume argv contract', () => {
  it('never passes -s / --sandbox to the resume subcommand', () => {
    const args = codexResumeArgs({ threadId: 'thread-1', prompt: 'continue' });
    expect(args).not.toContain('-s');
    expect(args).not.toContain('--sandbox');
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
