import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import { sendScratchChatMessage } from './send-chat-message';

vi.mock('@/lib/connection-budget', () => ({ fetchWithLongLivedBudget: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each([
  [429, { error: 'free_limit_reached' }],
  [403, { error: 'paid_tier_not_yet_active' }],
])('keeps error status %s without a commercial prompt', async (status, payload) => {
  vi.mocked(fetchWithLongLivedBudget).mockResolvedValue(Response.json(payload, { status: Number(status) }));
  const error = await sendScratchChatMessage({ history: [], message: 'Hello', onDelta: vi.fn() }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ status });
  expect((error as Error).message).not.toMatch(/paid|upgrade|pricing|plan/i);
});
