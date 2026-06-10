import { describe, expect, it } from 'vitest';

import { chainOnKey } from './keyed-promise-chain';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('chainOnKey', () => {
  it('serializes same-key calls in submission order', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];

    const first = chainOnKey(chains, 'repo-a', async () => {
      order.push('first:start');
      await tick();
      await tick();
      order.push('first:end');
      return 1;
    });
    const second = chainOnKey(chains, 'repo-a', async () => {
      order.push('second:start');
      return 2;
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs different keys concurrently', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });

    const a = chainOnKey(chains, 'repo-a', async () => {
      order.push('a:start');
      await gateA;
      order.push('a:end');
    });
    const b = chainOnKey(chains, 'repo-b', async () => {
      order.push('b:done');
    });

    await b;
    // b finished while a is still parked on its gate — keys don't serialize
    // against each other.
    expect(order).toEqual(['a:start', 'b:done']);
    releaseA();
    await a;
    expect(order).toEqual(['a:start', 'b:done', 'a:end']);
  });

  it('a rejection reaches its own caller but does not poison the chain', async () => {
    const chains = new Map<string, Promise<unknown>>();

    const failing = chainOnKey(chains, 'repo-a', async () => {
      throw new Error('merge failed');
    });
    const following = chainOnKey(chains, 'repo-a', async () => 'recovered');

    await expect(failing).rejects.toThrow('merge failed');
    await expect(following).resolves.toBe('recovered');
  });

  it('returns the inner result and propagates it through the chain tail', async () => {
    const chains = new Map<string, Promise<unknown>>();
    const result = await chainOnKey(chains, 'k', async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
    // The parked tail must be settled-safe (no unhandled rejection), so a
    // follow-up call still works after the map entry resolves.
    const next = await chainOnKey(chains, 'k', async () => 'next');
    expect(next).toBe('next');
  });
});
