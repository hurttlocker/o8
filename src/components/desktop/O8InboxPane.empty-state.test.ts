import { describe, expect, it } from 'vitest';
import { inboxEmptyStateCopy } from './O8InboxPane';

describe('Inbox empty-state copy', () => {
  it('never claims a recovery when the history contains no self-healed item', () => {
    const text = inboxEmptyStateCopy('active', 0);
    expect(text).toBe('No active approvals or supervisor inbox items.');
    expect(text).not.toContain('Heal-bot caught');
  });

  it('directs operators to real self-healed history only after a recovery exists', () => {
    expect(inboxEmptyStateCopy('active', 1)).toContain('See Self-healed');
    expect(inboxEmptyStateCopy('active', 2)).toContain('recorded recoveries');
  });

  it('preserves the Self-healed and All empty-state wording', () => {
    expect(inboxEmptyStateCopy('self_healed', 0)).toBe(
      'No self-healed items yet. Heal-bot will log fixes here.',
    );
    expect(inboxEmptyStateCopy('all', 0)).toBe('Supervisor inbox is empty.');
  });
});
