import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { rerunWithFeedback } from '@/lib/mcp/operator-mission-tools';
import { handleApproveAndMerge } from '@/lib/mcp/operator-handlers/approve';
import { handleClosePacketUnmerged } from '@/lib/mcp/operator-handlers/close-packet';
import { handleSend, handleSteerPacket } from '@/lib/mcp/operator-handlers/status';

const ROOT = join(__dirname, '..');

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sourceSection(file: string, start: string, end: string): string {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `${start} missing from ${file}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${end} missing after ${start} in ${file}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('packet mutation callers preserve one correlation id across transport retries', () => {
  it('MCP rerun retries the exact serialized request body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { dispatched: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = rerunWithFeedback({ packetId: 'pkt-mcp-rerun', feedback: 'try again' });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-rerun',
      feedback: 'try again',
      idempotencyKey: expect.any(String),
    });
  });

  it('MCP steer retries the exact serialized request body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { laneId: 'lane-mcp-steer' } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = handleSteerPacket({ packetId: 'pkt-mcp-steer', message: 'continue' });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-steer',
      message: 'continue',
      idempotencyKey: expect.any(String),
    });
  });

  it('MCP session steer polls its exact runtime mutation body before reading status', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url.includes('/api/operator/status')) return jsonResponse({ status: 'running' });
      const actionCalls = fetchMock.mock.calls.filter(([calledInput]) => (
        String(calledInput).includes('/api/runtime/action')
      )).length;
      if (actionCalls === 1) throw new Error('socket closed');
      if (actionCalls === 2) {
        return new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return jsonResponse({ ok: true, status: 'running' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = handleSend({ sessionKey: 'runtime-session-1', message: 'keep going' });
    await vi.runAllTimersAsync();
    await request;

    const runtimeCalls = fetchMock.mock.calls.filter(([input]) => (
      String(input).includes('/api/runtime/action')
    ));
    expect(runtimeCalls).toHaveLength(3);
    const requestBodies = runtimeCalls.map(([, init]) => String((init as RequestInit).body));
    expect(new Set(requestBodies).size).toBe(1);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      action: 'steer',
      surfaceId: 'runtime-session-1',
      message: 'keep going',
      clientMutationId: expect.any(String),
    });
  });

  it('MCP approve-and-merge polls the caller correlation id through HTTP 202', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { inProgress: true },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { merged: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = handleApproveAndMerge({
      packetId: 'pkt-mcp-merge',
      idempotencyKey: 'merge-correlation-1',
    });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-merge',
      idempotencyKey: 'merge-correlation-1',
    });
  });

  it('MCP close polls one exact client mutation through HTTP 202', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { inProgress: true },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { closed: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = handleClosePacketUnmerged({
      packetId: 'pkt-mcp-close',
      disposition: 'wontfix',
    });
    await vi.runAllTimersAsync();
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(JSON.parse(requestBodies[0])).toMatchObject({
      packetId: 'pkt-mcp-close',
      disposition: 'wontfix',
      clientMutationId: expect.any(String),
    });
  });
});

describe('desktop and preview packet mutation callers construct correlated bodies', () => {
  const browserCallers = [
    {
      file: 'src/components/desktop/O8InboxPane.tsx',
      start: 'const retryPacket = useCallback',
      end: 'const stopPacket = useCallback',
      endpoint: '/api/orchestrator/rerun-with-feedback',
    },
    {
      file: 'src/components/desktop/thoughts/mission-panel/RejectedFeedbackPanel.tsx',
      start: 'const handleSubmit = useCallback',
      end: 'const handleKeyDown = useCallback',
      endpoint: '/api/orchestrator/rerun-with-feedback',
    },
    {
      file: 'src/app/preview/canvas-glass/agent-card.tsx',
      start: 'const submitSteer =',
      end: 'const expandAction =',
      endpoint: '/api/orchestrator/steer-packet',
    },
  ];

  it.each(browserCallers)('$file correlates each $endpoint invocation', ({ file, start, end, endpoint }) => {
    const section = sourceSection(file, start, end);
    expect(section).toContain(endpoint);
    expect(section).toContain('const requestBody = JSON.stringify');
    expect(section).toContain('idempotencyKey: crypto.randomUUID()');
    expect(section).toContain('body: requestBody');
  });

  it('the shared review action polls reset, rerun, and merge receipts and stays latched on uncertainty', () => {
    const section = sourceSection(
      'src/components/desktop/thoughts/mission-panel/review-card/ReviewPane.tsx',
      'const callAction = useCallback',
      'const onMerge = useCallback',
    );
    expect(section).toContain("endpoint === '/api/orchestrator/reset-packet'");
    expect(section).toContain("endpoint === '/api/orchestrator/rerun-with-feedback'");
    expect(section).toContain("endpoint === '/api/orchestrator/merge'");
    expect(section).toContain('idempotencyKey: crypto.randomUUID()');
    expect(section).toContain('const requestBody = JSON.stringify(correlatedBody)');
    expect(section).toContain('body: requestBody');
    expect(section).toContain('fetchCorrelatedActionReceipt');
    expect(section).toContain('settleAction(inProgress)');
  });

  it('MCP runtime and lifecycle mutators share the exact-body receipt helper', () => {
    const cortexSource = readFileSync(join(ROOT, 'src/lib/mcp/cortex-mcp-server.ts'), 'utf8');
    expect(cortexSource).toContain('pollCorrelatedMcpApiMutation');
    expect(cortexSource).toContain("{ action: 'steer', surfaceId, message }");
    expect(cortexSource).toContain("{ action: 'interrupt', surfaceId }");

    const missionSource = readFileSync(join(ROOT, 'src/lib/mcp/operator-mission-tools.ts'), 'utf8');
    expect(missionSource).toContain('pollCorrelatedMcpMutation');
    expect(missionSource).toContain("correlationField: 'idempotencyKey'");
    expect(missionSource).toContain("'/api/orchestrator/reset-packet'");
    expect(missionSource).toContain("'/api/orchestrator/rerun-with-feedback'");

    const packetActions = readFileSync(join(ROOT, 'src/lib/orchestrator/packet-actions.ts'), 'utf8');
    expect(packetActions).toContain('fetchCorrelatedActionReceipt');
    expect(packetActions).toContain('unsettled: true');
  });

  it('the Activity mission stop polls one body and keeps its latch on uncertainty', () => {
    const section = sourceSection(
      'src/components/desktop/o8-panel/O8ActivityMissionControls.tsx',
      'const handleStopMission = useCallback',
      'const buttonStyle =',
    );
    expect(section).toContain("'/api/orchestrator/stop-mission'");
    expect(section).toContain('idempotencyKey: crypto.randomUUID()');
    expect(section).toContain('const requestBody = JSON.stringify');
    expect(section).toContain('body: requestBody');
    expect(section).toContain('fetchCorrelatedActionReceipt');
    expect(section).toContain('receiptUnsettled = correlatedActionIsUnsettled(error)');
    expect(section).toContain('if (!receiptUnsettled) setHaltBusy(false)');

    const activityPane = readFileSync(join(ROOT, 'src/components/desktop/O8ActivityPane.tsx'), 'utf8');
    expect(activityPane).toContain('<O8ActivityMissionControls');
  });

  it.each([
    'src/components/desktop/InlineDiffViewer.tsx',
    'src/components/desktop/merge-beacon/MergeBeacon.tsx',
    'src/components/desktop/review/panel/LaneReviewSummaryHeader.tsx',
    'src/components/desktop/workspace-terminal/ChatPacketStatusBanner.tsx',
    'src/app/preview/canvas-glass/diff-card.tsx',
  ])('%s gives each deliberate merge its own correlation id', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source).toContain('/api/orchestrator/merge');
    expect(source).toContain('idempotencyKey: crypto.randomUUID()');
  });

  it('the desktop agent launcher correlates each runtime launch invocation', () => {
    const section = sourceSection(
      'src/components/desktop/agent-panel/useAgentPanelState.ts',
      'const launchIntent = {',
      'if (!launchResponse.ok',
    );
    expect(section).toContain("runtime: 'codex'");
    expect(section).toContain('clientMutationId: crypto.randomUUID()');
    expect(section).toContain('requestBody: JSON.stringify({ ...launchIntent');
    expect(section).toContain('body: pending.requestBody');
    expect(section).toContain('fetchCorrelatedActionReceipt');
    expect(section).toContain('pendingRuntimeLaunches');
  });

  it.each([
    'src/components/desktop/workspace-terminal/AgentTilePane.tsx',
    'src/components/desktop/thoughts/chat-panel/runtimeInterrupt.ts',
  ])('%s polls the exact top-level runtime action receipt', (file) => {
    const source = readFileSync(join(ROOT, file), 'utf8');
    expect(source).toContain("from '@/lib/orchestrator/action-receipt'");
    expect(source).toContain("'/api/runtime/action'");
    expect(source).toContain('clientMutationId: crypto.randomUUID()');
    expect(source).toMatch(/requestBody\s*[:=]\s*JSON\.stringify/);
    expect(source).toMatch(/body: (?:pending\.)?requestBody/);
    expect(source).toContain('fetchCorrelatedActionReceipt');
  });

  it('the workspace chat pane routes owned steers through the exact receipt helper', () => {
    const caller = readFileSync(join(ROOT, 'src/components/desktop/workspace-terminal/useWorkspaceChatPane.ts'), 'utf8');
    const helper = readFileSync(join(ROOT, 'src/components/desktop/workspace-terminal/owned-runtime-steer.ts'), 'utf8');
    expect(caller).toContain('fetchOwnedRuntimeSteerReceipt(');
    expect(helper).toContain("from '@/lib/orchestrator/action-receipt'");
    expect(helper).toContain("'/api/runtime/action'");
    expect(helper).toContain('clientMutationId: crypto.randomUUID()');
    expect(helper).toContain('const requestBody = JSON.stringify');
    expect(helper).toContain('body: requestBody');
    expect(helper).toContain('fetchCorrelatedActionReceipt');
  });

  it('keeps uncertain desktop runtime mutations latched to their original identities', () => {
    const agentTile = readFileSync(join(ROOT, 'src/components/desktop/workspace-terminal/AgentTilePane.tsx'), 'utf8');
    expect(agentTile).toContain('receiptUnsettled = true');
    expect(agentTile).toContain('if (!receiptUnsettled)');

    const workspaceChat = readFileSync(join(ROOT, 'src/components/desktop/workspace-terminal/useWorkspaceChatPane.ts'), 'utf8');
    expect(workspaceChat).toContain('ownedDeliveryUnsettled = true');
    expect(workspaceChat).toContain('if (!ownedDeliveryUnsettled) setSending(false)');

    const agentPanel = readFileSync(join(ROOT, 'src/components/desktop/agent-panel/useAgentPanelState.ts'), 'utf8');
    expect(agentPanel).toContain('pendingRuntimeLaunches.get(launchKey)');
    expect(agentPanel).toContain('if (correlatedActionIsUnsettled(error)) pending.promise = null');

    const runtimeInterrupt = readFileSync(join(ROOT, 'src/components/desktop/thoughts/chat-panel/runtimeInterrupt.ts'), 'utf8');
    expect(runtimeInterrupt).toContain('pendingRuntimeInterrupts.get(surfaceId)');
    expect(runtimeInterrupt).toContain('else pending.promise = null');
  });

  it.each([
    {
      file: 'src/components/desktop/thoughts/ThoughtsChatPanel.tsx',
      start: 'const ensureSingleRuntimeSession = useCallback',
      end: '// ── Pre-warm orchestrator session on mount ──',
    },
    {
      file: 'src/components/desktop/thoughts/ThoughtsChatPanel.tsx',
      start: '// ── Pre-warm orchestrator session on mount ──',
      end: 'useEffect(() => {\n    openRef.current = open;',
    },
  ])('$file runtime launch section polls through the correlated receipt helper', ({ file, start, end }) => {
    const section = sourceSection(file, start, end);
    expect(section).toContain('fetchRuntimeLaunchReceipt({');
    expect(section).not.toContain("fetch('/api/runtime/launch'");
  });

  it('the mobile launch sheet polls one runtime launch receipt and stays latched if it is unsettled', () => {
    const section = sourceSection(
      'src/components/mobile/LaunchSheet.tsx',
      'const handleLaunch = useCallback',
      'if (!open) return null;',
    );
    expect(section).toContain('fetchRuntimeLaunchReceipt(body)');
    expect(section).toContain('if (!correlatedActionIsUnsettled(err)) setLaunching(false)');
    expect(section).not.toContain("fetch('/api/runtime/launch'");
  });

  it('the thoughts chat runtime steer paths stay latched on unresolved receipts', () => {
    const source = readFileSync(join(ROOT, 'src/components/desktop/thoughts/ThoughtsChatPanel.tsx'), 'utf8');
    expect(source.match(/fetchRuntimeSteerReceipt\(/g)?.length).toBe(2);
    expect(source.match(/correlatedActionIsUnsettled\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(source).toContain('if (!receiptUnsettled) setWaitingForReply(false)');
    expect(source).not.toContain("fetch('/api/runtime/action'");
  });

  it('the shared runtime receipt helper owns the one mutation id and exact serialized body', () => {
    const source = readFileSync(join(ROOT, 'src/lib/orchestrator/runtime-mutation-receipt.ts'), 'utf8');
    expect(source.match(/clientMutationId: crypto\.randomUUID\(\)/g)?.length).toBe(2);
    expect(source.match(/const requestBody = JSON\.stringify/g)?.length).toBe(2);
    expect(source.match(/body: requestBody/g)?.length).toBe(2);
    expect(source.match(/fetchCorrelatedActionReceipt/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
