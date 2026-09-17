import { afterEach, describe, expect, it, vi } from 'vitest';

import { askJudgment } from './client';
import { DIFF_QUESTIONS } from './questions';
import { listJudgmentReceipts } from './receipts';
import { getOperatorDefaults } from '@/lib/operator/defaults';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.O8_JUDGMENT_API_KEY;
});

describe('askJudgment with judgment.provider off', () => {
  it('returns null without opening a socket or writing a receipt', async () => {
    process.env.O8_JUDGMENT_API_KEY = 'ts-key-should-never-be-used';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await getOperatorDefaults()).values.judgmentProvider).toBe('off');

    const result = await askJudgment({
      state: { files: [], docsOnly: false, diff: '', truncated: false },
      questions: { docsOnly: DIFF_QUESTIONS.docsOnly },
      context: { surface: 'test' },
    });

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(listJudgmentReceipts()).toEqual([]);
  });
});
