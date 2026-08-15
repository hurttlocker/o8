// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceParkControl, workspaceControlCopy } from './WorkspaceParkControl';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('workspaceControlCopy', () => {
  it('keeps parked review truth visible and makes restore the only action', () => {
    expect(workspaceControlCopy({
      state: 'parked',
      canPark: false,
      canRestore: true,
      reviewable: true,
      branch: 'inline/packet-1',
      reviewedHead: 'head-1',
      note: null,
    }, null)).toEqual({
      label: 'Restore',
      action: 'restore',
      detail: 'Parked · restore available',
    });
  });

  it('names the long-running stage and exposes no second action while busy', () => {
    expect(workspaceControlCopy({
      state: 'materialized',
      canPark: true,
      canRestore: false,
      reviewable: true,
      branch: 'inline/packet-1',
      reviewedHead: null,
      note: null,
    }, 'park')).toEqual({
      label: 'Checking workspace…',
      action: null,
      detail: 'Verifying clean files and process state.',
    });
  });

  it('keeps a parked workspace non-actionable when its restore path is unavailable', () => {
    expect(workspaceControlCopy({
      state: 'parked',
      canPark: false,
      canRestore: false,
      reviewable: true,
      branch: 'inline/packet-1',
      reviewedHead: 'head-1',
      note: 'The original workspace path is occupied.',
    }, null)).toEqual({
      label: 'Restore blocked',
      action: null,
      detail: 'Parked · restore unavailable',
    });
  });

  it('keeps an uncertain exact mutation locked without implying progress', () => {
    expect(workspaceControlCopy({
      state: 'hibernating',
      canPark: false,
      canRestore: false,
      reviewable: false,
      branch: 'inline/packet-1',
      reviewedHead: 'head-1',
      note: null,
    }, 'park', true)).toEqual({
      label: 'Outcome unknown',
      action: null,
      detail: 'Exact workspace mutation remains locked.',
    });
  });
});

describe('WorkspaceParkControl', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    window.sessionStorage.clear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(async () => root.unmount());
    vi.useRealTimers();
    document.body.replaceChildren();
    window.sessionStorage.clear();
  });

  it.each([
    {
      action: 'park' as const,
      initialState: 'materialized' as const,
      initialAction: 'Park workspace',
      intermediateState: 'parkable' as const,
      intermediateLabel: 'Protecting review…',
      workingState: 'hibernating' as const,
      workingLabel: 'Removing workspace copy…',
      terminalState: 'parked' as const,
      terminalBusyLabel: 'Confirming parked receipt…',
      terminalAction: 'Restore',
    },
    {
      action: 'restore' as const,
      initialState: 'parked' as const,
      initialAction: 'Restore',
      intermediateState: 'restoring' as const,
      intermediateLabel: 'Recreating workspace…',
      workingState: 'restoring' as const,
      workingLabel: 'Recreating workspace…',
      terminalState: 'materialized' as const,
      terminalBusyLabel: 'Confirming restored receipt…',
      terminalAction: 'Park workspace',
    },
  ])('shows backend-derived $action stages past three seconds and resets on terminal receipt', async (testCase) => {
    vi.useFakeTimers();
    let state = testCase.initialState as 'materialized' | 'parkable' | 'hibernating' | 'parked' | 'restoring';
    let resolvePost: ((value: Response) => void) | null = null;
    const post = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return post;
      return Promise.resolve(response({
        ok: true,
        result: {
          state,
          canPark: state === 'materialized',
          canRestore: state === 'parked',
          reviewable: state !== 'hibernating' && state !== 'restoring',
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          note: null,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => `workspace-${testCase.action}-1` });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const actionButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === testCase.initialAction);
    await act(async () => {
      actionButton?.click();
      await Promise.resolve();
    });
    if (testCase.action === 'park') {
      const confirmButton = [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Confirm park');
      await act(async () => {
        confirmButton?.click();
        await Promise.resolve();
      });
    }

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(host.textContent).toContain(testCase.action === 'park' ? 'Checking workspace…' : 'Checking restore path…');

    state = testCase.intermediateState;
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(host.textContent).toContain(testCase.intermediateLabel);
    state = testCase.workingState;
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(host.textContent).toContain(testCase.workingLabel);
    state = testCase.terminalState;
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(host.textContent).toContain(testCase.terminalBusyLabel);

    await act(async () => {
      resolvePost?.(response({
        ok: true,
        result: { state, status: testCase.action === 'park' ? 'parked' : 'restored' },
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain(testCase.terminalAction);
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });

  it('stops progress polling when an exact mutation becomes outcome-unknown', async () => {
    vi.useFakeTimers();
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(response({
          ok: false,
          error: { message: 'The exact outcome could not be recovered.' },
          result: { outcomeUnknown: true, status: 'outcome_unknown' },
        }, 409));
      }
      getCount += 1;
      return Promise.resolve(response({
        ok: true,
        result: {
          state: 'hibernating',
          canPark: false,
          canRestore: false,
          reviewable: false,
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          note: null,
        },
      }));
    }));
    vi.stubGlobal('crypto', { randomUUID: () => 'workspace-unknown-1' });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const actionButton = host.querySelector<HTMLButtonElement>('button');
    expect(actionButton?.textContent).toBe('Parking…');
    window.sessionStorage.setItem('o8:workspace-mutation:packet-1', JSON.stringify({
      action: 'park', packetId: 'packet-1', clientMutationId: 'workspace-unknown-1',
    }));
    await act(async () => {
      root.render(null);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Outcome unknown');
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    const settledGetCount = getCount;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getCount).toBe(settledGetCount);
    expect(window.sessionStorage.getItem('o8:workspace-mutation:packet-1')).toContain('workspace-unknown-1');
  });

  it('resumes the exact mutation body after an uncertain control remount', async () => {
    let postCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) return new Promise<Response>(() => undefined);
        return Promise.resolve(response({
          ok: true,
          result: { state: 'parked', status: 'parked', note: 'Workspace parked.' },
        }));
      }
      return Promise.resolve(response({
        ok: true,
        result: {
          state: postCount > 1 ? 'parked' : 'materialized',
          canPark: postCount <= 1,
          canRestore: postCount > 1,
          reviewable: true,
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          note: null,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'workspace-mutation-1' });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const parkButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Park workspace');
    expect(parkButton).toBeTruthy();

    await act(async () => {
      parkButton?.click();
      await Promise.resolve();
    });
    const confirmButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Confirm park');
    await act(async () => {
      confirmButton?.click();
      await Promise.resolve();
    });
    const firstBody = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body;
    expect(JSON.parse(String(firstBody))).toEqual({
      action: 'park',
      packetId: 'packet-1',
      clientMutationId: 'workspace-mutation-1',
    });

    await act(async () => {
      root.render(null);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const postBodies = fetchMock.mock.calls
      .filter((call) => call[1]?.method === 'POST')
      .map((call) => call[1]?.body);
    expect(postBodies).toEqual([firstBody, firstBody]);
    expect(window.sessionStorage.length).toBe(0);
    expect(host.textContent).toContain('Parked · restore available');
  });

  it('requires an inline danger confirmation before parking and cancel stays mutation-free', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(response({ ok: true, result: { state: 'parked', status: 'parked' } }));
      }
      return Promise.resolve(response({
        ok: true,
        result: {
          state: 'materialized',
          canPark: true,
          canRestore: false,
          reviewable: true,
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          note: null,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'workspace-confirm-1' });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Park workspace')?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Confirm park');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);

    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Cancel')?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Park workspace');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });

  it('ignores an out-of-order status response after the packet changes', async () => {
    let resolvePacketA: ((value: Response) => void) | null = null;
    let resolvePacketB: ((value: Response) => void) | null = null;
    const packetA = new Promise<Response>((resolve) => { resolvePacketA = resolve; });
    const packetB = new Promise<Response>((resolve) => { resolvePacketB = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(response({ ok: true, result: { state: 'parked', status: 'parked' } }));
      }
      if (String(input).includes('packetId=packet-b')) return packetB;
      return packetA;
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-a' }));
      await Promise.resolve();
    });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-b' }));
      await Promise.resolve();
    });
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).not.toContain('Confirm park');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);

    await act(async () => {
      resolvePacketB?.(response({
        ok: true,
        result: {
          state: 'parked',
          canPark: false,
          canRestore: true,
          reviewable: true,
          branch: 'inline/packet-b',
          reviewedHead: 'head-b',
          note: null,
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolvePacketA?.(response({
        ok: true,
        result: {
          state: 'materialized',
          canPark: true,
          canRestore: false,
          reviewable: true,
          branch: 'inline/packet-a',
          reviewedHead: 'head-a',
          note: null,
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Restore');
    expect(host.textContent).not.toContain('Park workspace');
    expect(host.textContent).not.toContain('Confirm park');
  });

  it('ignores an older same-packet poll after the terminal status read settles', async () => {
    vi.useFakeTimers();
    let getCount = 0;
    let resolvePost: ((value: Response) => void) | null = null;
    let resolveOlderPoll: ((value: Response) => void) | null = null;
    let resolveTerminalRead: ((value: Response) => void) | null = null;
    const post = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const olderPoll = new Promise<Response>((resolve) => { resolveOlderPoll = resolve; });
    const terminalRead = new Promise<Response>((resolve) => { resolveTerminalRead = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return post;
      getCount += 1;
      if (getCount === 1) {
        return Promise.resolve(response({
          ok: true,
          result: {
            state: 'materialized',
            canPark: true,
            canRestore: false,
            reviewable: true,
            branch: 'inline/packet-1',
            reviewedHead: 'head-1',
            note: null,
          },
        }));
      }
      return getCount === 2 ? olderPoll : terminalRead;
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'workspace-same-packet-order' });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Park workspace')?.click();
      await Promise.resolve();
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Confirm park')?.click();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(getCount).toBe(2);

    await act(async () => {
      resolvePost?.(response({ ok: true, result: { state: 'parked', status: 'parked' } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getCount).toBe(3);
    await act(async () => {
      resolveTerminalRead?.(response({
        ok: true,
        result: {
          state: 'parked',
          canPark: false,
          canRestore: true,
          reviewable: true,
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          note: null,
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveOlderPoll?.(response({
        ok: true,
        result: {
          state: 'materialized',
          canPark: true,
          canRestore: false,
          reviewable: true,
          branch: 'inline/packet-1',
          reviewedHead: 'head-1',
          note: null,
        },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Restore');
    expect(host.textContent).not.toContain('Park workspace');
  });

  it('clears an open park confirmation synchronously when the packet changes', async () => {
    const pendingPacketB = new Promise<Response>(() => undefined);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(response({ ok: true, result: { state: 'parked', status: 'parked' } }));
      }
      if (String(input).includes('packetId=packet-b')) return pendingPacketB;
      return Promise.resolve(response({
        ok: true,
        result: {
          state: 'materialized',
          canPark: true,
          canRestore: false,
          reviewable: true,
          branch: 'inline/packet-a',
          reviewedHead: 'head-a',
          note: null,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-a' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Park workspace')?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Confirm park');

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-b' }));
      await Promise.resolve();
    });
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).not.toContain('Confirm park');
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });

  it('resumes packet B after packet A settles without painting A outcome state', async () => {
    let resolvePacketA: ((value: Response) => void) | null = null;
    const packetAPost = new Promise<Response>((resolve) => { resolvePacketA = resolve; });
    const postBodies: Array<{ action: string; packetId: string; clientMutationId: string }> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          action: string; packetId: string; clientMutationId: string;
        };
        postBodies.push(body);
        if (body.packetId === 'packet-a') return packetAPost;
        return Promise.resolve(response({
          ok: true,
          result: { state: 'parked', status: 'parked', note: 'Packet B parked.' },
        }));
      }
      const packetId = new URL(String(_input), 'http://localhost').searchParams.get('packetId');
      return Promise.resolve(response({
        ok: true,
        result: {
          state: packetId === 'packet-b' ? 'parked' : 'materialized',
          canPark: packetId === 'packet-a',
          canRestore: packetId === 'packet-b',
          reviewable: true,
          branch: `inline/${packetId}`,
          reviewedHead: 'head-1',
          note: null,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: () => 'mutation-a',
    });

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-a' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Park workspace')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Confirm park')?.click();
      await Promise.resolve();
    });
    window.sessionStorage.setItem('o8:workspace-mutation:packet-b', JSON.stringify({
      action: 'restore',
      packetId: 'packet-b',
      clientMutationId: 'mutation-b',
    }));
    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-b' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(postBodies.filter((body) => body.packetId === 'packet-b')).toEqual([{
      action: 'restore', packetId: 'packet-b', clientMutationId: 'mutation-b',
    }]);

    await act(async () => {
      resolvePacketA?.(response({
        ok: false,
        error: { message: 'Packet A outcome is unknown.' },
        result: { outcomeUnknown: true, status: 'outcome_unknown' },
      }, 409));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Packet B parked.');
    expect(host.textContent).not.toContain('Packet A outcome is unknown.');
    expect(host.textContent).not.toContain('Outcome unknown');
  });

  it('surfaces a persisted quarantined restore note without offering another action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ok: true,
      result: {
        state: 'restoring',
        canPark: false,
        canRestore: false,
        reviewable: false,
        branch: 'inline/packet-1',
        reviewedHead: 'head-1',
        note: 'The original path is occupied, so restore remains quarantined.',
      },
    })));

    await act(async () => {
      root.render(createElement(WorkspaceParkControl, { packetId: 'packet-1' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('The original path is occupied');
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });
});
