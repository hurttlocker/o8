import { expect, it } from 'vitest';
import { mergeMobileTurnReceipts } from '@/lib/mobile/turn-receipt';
import type { MobileTurnReceipt } from '@/lib/mobile/types';
import { voiceTerminalContext } from './terminal-context';

it('restores exact-task evidence and does not turn a late unknown snapshot into a lost result', () => {
  const receipt: MobileTurnReceipt = { leadModel: 'selected', effort: 'high', mode: 'multitask',
    terminal: { userMessageId: 'user-one', outcome: 'completed' } };
  const stale: MobileTurnReceipt = { ...receipt, terminal: { userMessageId: 'user-one', outcome: 'unconfirmed' } };
  expect(mergeMobileTurnReceipts(receipt, stale)?.terminal?.outcome).toBe('completed');
  const restored = voiceTerminalContext([{ id: 'answer', role: 'assistant', text: 'Verified result', receipt }], {
    'user-one': { outcome: 'unconfirmed', text: 'partial' }, 'user-two': { outcome: 'unconfirmed', text: 'new task' },
  });
  expect(restored['user-one']).toEqual({ outcome: 'completed', text: 'Verified result' });
  expect(restored['user-two'].outcome).toBe('unconfirmed');
});
