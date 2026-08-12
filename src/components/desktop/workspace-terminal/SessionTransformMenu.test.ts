// @vitest-environment jsdom

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTransformMenu, submitSessionTransform } from './SessionTransformMenu';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SessionTransformMenu', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('reads route capability truth and submits the current catalog version', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        capabilities: {
          import: { supported: true },
          checkpoint: { supported: true },
          fork: { supported: true },
          rewind: { supported: true },
        },
        catalogVersion: 7,
        catalogSession: null,
        checkpoints: [],
      }))
      .mockResolvedValueOnce(response({
        ok: true,
        note: 'Session added without changing ownership.',
        catalogVersion: 8,
      }))
      .mockResolvedValueOnce(response({
        capabilities: {
          import: { supported: true },
          checkpoint: { supported: true },
          fork: { supported: true },
          rewind: { supported: true },
        },
        catalogVersion: 8,
        catalogSession: { ownership: 'discovered', provenance: 'import' },
        checkpoints: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(SessionTransformMenu, {
        runtimeId: 'codex',
        sessionKey: 'codex:thread-1',
      }));
      await Promise.resolve();
    });

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Session history controls"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    const importButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent === 'Add to o8') as HTMLButtonElement | undefined;
    expect(importButton).toBeTruthy();
    await act(async () => {
      importButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: 'import',
      runtimeId: 'codex',
      sessionKey: 'codex:thread-1',
      expectedCatalogVersion: 7,
      clientMutationId: expect.any(String),
    });
  });

  it('reuses one exact mutation body through transport loss and 202 polling', async () => {
    vi.useFakeTimers();
    const request = vi.fn()
      .mockRejectedValueOnce(new TypeError('transport lost'))
      .mockResolvedValueOnce(response({ ok: true, inProgress: true }, 202))
      .mockResolvedValueOnce(response({ ok: true, note: 'forked once' }));
    const body = {
      action: 'fork' as const,
      runtimeId: 'codex',
      sessionKey: 'codex:thread-1',
      checkpointId: 'checkpoint-1',
      expectedCatalogVersion: 7,
      clientMutationId: 'ui-deliberate-invocation-1',
    };

    const resultPromise = submitSessionTransform(body, request as typeof fetch);
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toMatchObject({ note: 'forked once' });
    expect(request).toHaveBeenCalledTimes(3);
    const serializedBodies = request.mock.calls.map((call) => call[1]?.body);
    expect(new Set(serializedBodies)).toEqual(new Set([JSON.stringify(body)]));
  });

  it('renders no affordance when the route says every transform is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      capabilities: {
        import: { supported: false, reason: 'unsupported' },
        checkpoint: { supported: false, reason: 'unsupported' },
        fork: { supported: false, reason: 'unsupported' },
        rewind: { supported: false, reason: 'unsupported' },
      },
      catalogVersion: 0,
      catalogSession: null,
      checkpoints: [],
    })));
    await act(async () => {
      root.render(createElement(SessionTransformMenu, {
        runtimeId: 'codex',
        sessionKey: 'codex-owned:surface-1',
      }));
      await Promise.resolve();
    });
    expect(host.querySelector('button[aria-label="Session history controls"]')).toBeNull();
  });
});
