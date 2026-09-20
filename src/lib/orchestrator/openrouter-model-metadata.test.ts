import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearOpenRouterModelMetadataCache,
  getOpenRouterModelMetadata,
} from './openrouter-model-metadata';

afterEach(() => {
  clearOpenRouterModelMetadataCache();
  vi.unstubAllGlobals();
});

describe('getOpenRouterModelMetadata', () => {
  it('caches public sorted metadata, recognizes documented free variants, and excludes non-text outputs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
          name: 'Nemotron 3 Ultra 550B A55B (free)',
          pricing: { prompt: '0', completion: '0' },
          architecture: { output_modalities: ['text'] },
        },
        {
          id: 'acme/request-priced:free',
          name: 'Request-priced free suffix',
          pricing: { prompt: '0', completion: '0', request: '0.01' },
          architecture: { output_modalities: ['text'] },
        },
        {
          id: 'acme/zero-priced-without-free-suffix',
          name: 'Unknown zero price',
          pricing: { prompt: '0', completion: '0' },
          architecture: { output_modalities: ['text'] },
        },
        {
          id: 'google/nano-banana-pro',
          name: 'Nano Banana Pro',
          pricing: { prompt: '0.001', completion: '0.002' },
          architecture: { output_modalities: ['text', 'image'] },
        },
        {
          id: 'openai/gpt-audio',
          name: 'GPT Audio',
          pricing: { prompt: '0.001', completion: '0.002' },
          architecture: { output_modalities: ['text', 'audio'] },
        },
        {
          id: 'acme/multimodal-input-text-output',
          name: 'Multimodal input coding model',
          pricing: { prompt: '0.001', completion: '0.002' },
          architecture: { output_modalities: ['text'] },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await getOpenRouterModelMetadata('most-popular');
    const second = await getOpenRouterModelMetadata('most-popular');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('sort=most-popular');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('output_modalities=text');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('supported_parameters=tools');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(first?.get('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')).toMatchObject({ rank: 0, free: true, compatible: true });
    expect(first?.get('openrouter/acme/request-priced:free')?.free).toBe(false);
    expect(first?.get('openrouter/acme/zero-priced-without-free-suffix')?.free).toBeUndefined();
    expect(first?.get('openrouter/google/nano-banana-pro')?.compatible).toBe(false);
    expect(first?.get('openrouter/openai/gpt-audio')?.compatible).toBe(false);
    expect(first?.get('openrouter/acme/multimodal-input-text-output')?.compatible).toBe(true);
    expect(second).toBe(first);
  });

  it('falls back honestly when public metadata is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'AbortError')));
    await expect(getOpenRouterModelMetadata('newest')).resolves.toBeNull();
  });
});
