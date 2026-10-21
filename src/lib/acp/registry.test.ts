import { describe, expect, it, vi } from 'vitest';
import { createAcpRegistryReader, decodeAcpRegistry } from './registry';

const agent = { id: 'fixture', name: 'Fixture', version: '1.0.0', description: 'Local test', distribution: { npx: { package: 'fixture-agent@1.0.0', args: ['acp'] } } };
describe('ACP registry metadata', () => {
  it('accepts pinned registry packages without turning URLs or scripts into executable instructions', () => {
    const [row] = decodeAcpRegistry({ agents: [agent] });
    expect(row.npm).toEqual({ package: 'fixture-agent@1.0.0', args: ['acp'] });
    expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const value of ['fixture-agent@latest', 'https://example.test/package.tgz', 'git+ssh://example.test/agent', 'fixture;rm -rf /']) {
      expect(decodeAcpRegistry({ agents: [{ ...agent, distribution: { npx: { package: value } } }] })[0].npm).toBeUndefined();
    }
    expect(decodeAcpRegistry({ agents: [{ ...agent, name: '   ' }] })).toEqual([]);
  });
  it('shares concurrent reads and marks an offline fallback stale', async () => {
    const request = vi.fn(async () => Response.json({ agents: [agent] }));
    const read = createAcpRegistryReader(request);
    expect((await Promise.all([read(), read()])).map(value => value.agents.length)).toEqual([1, 1]);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error('offline'));
    expect((await read(true)).stale).toBe(true);
  });
  it('cancels an oversized streaming response before buffering the whole body', async () => {
    const cancel = vi.fn(); let chunks = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel,
    }));
    const read = createAcpRegistryReader(vi.fn(async () => response));
    await expect(read()).rejects.toThrow('could not be loaded');
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(4);
  });
});
