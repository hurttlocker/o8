import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPrJson } from './read-pr-json';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('pull request read recovery', () => {
  it('bounds a stuck fetch and leaves the next read available', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))).mockResolvedValueOnce(Response.json({ pr: { number: 7 } })));
    const pending = readPrJson('/api/panel/prs/7');
    const rejection = expect(pending).rejects.toThrow('timed out. Retry.');
    await vi.advanceTimersByTimeAsync(25_000); await rejection;
    await expect(readPrJson('/api/panel/prs/7')).resolves.toEqual({ pr: { number: 7 } });
  });
});
