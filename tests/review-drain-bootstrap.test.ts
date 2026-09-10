import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), enqueue: vi.fn() }));
vi.mock('@/lib/lane/auto-review', () => ({
  startReviewQueueDrain: mocks.start,
  triggerAutoReview: mocks.enqueue,
}));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/lane/registry', () => ({ getLane: vi.fn() }));

const runtime = globalThis as typeof globalThis & {
  __o8ReviewQueueDrain?: { stop: () => void };
};

beforeEach(() => {
  delete runtime.__o8ReviewQueueDrain;
  vi.clearAllMocks();
  mocks.start.mockImplementation(() => mocks.stop);
});
afterEach(() => {
  runtime.__o8ReviewQueueDrain?.stop();
  delete runtime.__o8ReviewQueueDrain;
});

describe('server-owned review queue bootstrap', () => {
  it('shares one drain across startup, reloaded bundles, and the real start route', async () => {
    const first = await import('@/lib/lane/review-drain-bootstrap');
    first.ensureReviewQueueDrainStarted();
    first.ensureReviewQueueDrainStarted();
    vi.resetModules();
    const second = await import('@/lib/lane/review-drain-bootstrap');
    second.ensureReviewQueueDrainStarted();
    const { POST } = await import('@/app/api/review/auto-review/route');
    const response = await POST(new NextRequest('http://localhost/api/review/auto-review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('keeps startup retryable when initialization throws', async () => {
    const { ensureReviewQueueDrainStarted } = await import('@/lib/lane/review-drain-bootstrap');
    mocks.start.mockImplementationOnce(() => { throw new Error('queue initialization unavailable'); });
    expect(ensureReviewQueueDrainStarted).toThrow('queue initialization unavailable');
    expect(runtime.__o8ReviewQueueDrain).toBeUndefined();
    ensureReviewQueueDrainStarted();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(runtime.__o8ReviewQueueDrain?.stop).toBe(mocks.stop);
  });
});
