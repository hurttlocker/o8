import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
const printJsonMock = vi.fn();

vi.mock('../cli/src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/api.js')>();
  return { ...actual, apiFetch: apiFetchMock };
});
vi.mock('../cli/src/config.js', () => ({
  resolveConfig: () => ({ apiBase: 'http://127.0.0.1:47120' }),
}));
vi.mock('../cli/src/output.js', () => ({
  printHumanHeading: vi.fn(),
  printHumanKv: vi.fn(),
  printJson: printJsonMock,
}));

const { runSession } = await import('../cli/src/commands/session.js');
const { CliError, EXIT } = await import('../cli/src/api.js');

describe('session transform CLI', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    printJsonMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses capability truth and the catalog version from GET for a transform CAS', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        status: 200,
        data: {
          runtimeId: 'codex',
          sessionKey: 'codex-discovered:provider-thread',
          capabilities: {
            import: { supported: true },
            checkpoint: { supported: true },
            fork: { supported: true },
            rewind: { supported: true },
          },
          catalogVersion: 8,
          catalogSession: null,
          checkpoints: [],
          receipts: [],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          action: 'import',
          resultingSessionKey: 'codex-discovered:provider-thread',
        },
      });

    await expect(runSession(
      { human: false, verbose: false },
      'import',
      ['codex-discovered:provider-thread'],
    )).resolves.toBe(0);

    expect(apiFetchMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      '/api/runtime/session-transform',
      { query: { runtimeId: 'codex', sessionKey: 'codex-discovered:provider-thread' } },
    );
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      '/api/runtime/session-transform',
      expect.objectContaining({
        method: 'POST',
        body: {
          action: 'import',
          runtimeId: 'codex',
          sessionKey: 'codex-discovered:provider-thread',
          checkpointId: undefined,
          expectedCatalogVersion: 8,
          clientMutationId: expect.any(String),
        },
      }),
    );
    expect(printJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'o8/cli/session.import/v1',
      resultingSessionKey: 'codex-discovered:provider-thread',
    }));
  });

  it('does not mutate when the GET capability says unsupported', async () => {
    apiFetchMock.mockResolvedValueOnce({
      status: 200,
      data: {
        runtimeId: 'fixture',
        sessionKey: 'fixture:session',
        capabilities: {
          import: { supported: false, reason: 'provider does not support import' },
          checkpoint: { supported: false },
          fork: { supported: false },
          rewind: { supported: false },
        },
        catalogVersion: 0,
        catalogSession: null,
        checkpoints: [],
        receipts: [],
      },
    });

    await expect(runSession(
      { human: false, verbose: false },
      'import',
      ['fixture:session', '--runtime', 'fixture'],
    )).rejects.toMatchObject({ code: 'unsupported' });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires explicit provider inspection before dismissing an unresolved attempt', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        status: 200,
        data: {
          runtimeId: 'codex',
          sessionKey: 'codex:provider-thread',
          capabilities: {},
          catalogVersion: 12,
          catalogSession: null,
          checkpoints: [],
          receipts: [],
          pendingTransform: {
            id: 'transform-unresolved',
            action: 'fork',
            phase: 'provider_started',
            manualResolutionRequired: true,
          },
        },
      })
      .mockResolvedValueOnce({ status: 200, data: { ok: true, action: 'dismiss_pending' } });

    await expect(runSession(
      { human: false, verbose: false },
      'dismiss-pending',
      ['codex:provider-thread'],
    )).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(apiFetchMock).not.toHaveBeenCalled();

    await expect(runSession(
      { human: false, verbose: false },
      'dismiss-pending',
      ['codex:provider-thread', '--confirm-no-continuation'],
    )).resolves.toBe(0);
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      '/api/runtime/session-transform',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          action: 'dismiss_pending',
          intentId: 'transform-unresolved',
          providerOutcome: 'no_continuation',
          expectedCatalogVersion: 12,
          clientMutationId: expect.any(String),
        }),
      }),
    );
  });

  it('reuses one mutation id and exact body through transport loss and 202 polling', async () => {
    vi.useFakeTimers();
    apiFetchMock
      .mockResolvedValueOnce({
        status: 200,
        data: {
          runtimeId: 'codex',
          sessionKey: 'codex:provider-thread',
          capabilities: {
            import: { supported: true },
            checkpoint: { supported: true },
            fork: { supported: true },
            rewind: { supported: true },
          },
          catalogVersion: 4,
          catalogSession: null,
          checkpoints: [],
          receipts: [],
          pendingTransform: null,
        },
      })
      .mockRejectedValueOnce(new CliError(
        'server_timeout',
        'response lost',
        EXIT.SERVER_TIMEOUT,
        undefined,
        true,
      ))
      .mockResolvedValueOnce({ status: 202, data: { ok: true, inProgress: true } })
      .mockResolvedValueOnce({
        status: 200,
        data: { ok: true, action: 'import', resultingSessionKey: 'codex:provider-thread' },
      });

    const resultPromise = runSession(
      { human: false, verbose: false },
      'import',
      ['codex:provider-thread'],
    );
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe(0);

    const mutations = apiFetchMock.mock.calls.filter((call) => call[2]?.method === 'POST');
    expect(mutations).toHaveLength(3);
    expect(mutations[1]?.[2]?.body).toBe(mutations[0]?.[2]?.body);
    expect(mutations[2]?.[2]?.body).toBe(mutations[0]?.[2]?.body);
    expect(mutations[0]?.[2]?.body).toMatchObject({
      clientMutationId: expect.any(String),
      action: 'import',
      expectedCatalogVersion: 4,
    });
  });

  it('reuses one resume mutation body through an ambiguous response and top-level 202', async () => {
    vi.useFakeTimers();
    apiFetchMock
      .mockRejectedValueOnce(new CliError(
        'network_error',
        'response lost',
        EXIT.CONNECTION_REFUSED,
        undefined,
        true,
      ))
      .mockResolvedValueOnce({ status: 202, data: { ok: true, status: 'queued', inProgress: true } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true, status: 'completed', note: 'Resume sent.' } });

    const resultPromise = runSession(
      { human: false, verbose: false },
      'resume',
      ['codex:provider-thread', '--message', 'continue from the checkpoint'],
    );
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toBe(0);

    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    const bodies = apiFetchMock.mock.calls.map((call) => call[2]?.body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(bodies[0]).toMatchObject({
      action: 'send_input',
      surfaceId: 'codex:provider-thread',
      clientMutationId: expect.any(String),
      message: 'continue from the checkpoint',
    });
  });
});
