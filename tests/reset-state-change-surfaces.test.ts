import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ mcpResetPacket: vi.fn(), resetPacket: vi.fn() }));

vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>();
  return { ...actual, resetPacket: h.resetPacket };
});

vi.mock('@/lib/mcp/operator-mission-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/operator-mission-tools')>();
  return { ...actual, resetPacket: h.mcpResetPacket };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-reset-state-changed-'));
const operatorToken = 'operator-reset-state-changed-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/orchestrator/reset-packet/route');
const { handleRetryPacket } = await import('@/lib/mcp/operator-handlers/mission');
const { closeDb } = await import('@/lib/db');

function post(idempotencyKey = 'retry-state-race') {
  return new NextRequest('http://localhost:3001/api/orchestrator/reset-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      packetId: 'packet-state-race',
      clearWorktree: false,
      idempotencyKey,
    }),
  });
}

beforeEach(() => {
  h.mcpResetPacket.mockReset();
  h.resetPacket.mockReset();
  const noOp = {
    reset: false,
    salvaged: false,
    packetId: 'packet-state-race',
    note: 'Packet generation changed before retry salvage could bind.',
  };
  h.mcpResetPacket.mockRejectedValue(
    new Error('Packet generation changed before retry salvage could bind.'),
  );
  h.resetPacket.mockResolvedValue(noOp);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reset state-change truth across operator surfaces', () => {
  it('returns the same terminal conflict receipt without repeating the reset', async () => {
    const first = await route.POST(post());
    const second = await route.POST(post());

    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'reset_state_changed' },
    });
    expect(second.status).toBe(409);
    expect(h.resetPacket).toHaveBeenCalledTimes(1);
  });

  it('returns an accepted in-progress receipt for a live duplicate without starting another reset', async () => {
    const deferred = Promise.withResolvers<{
      reset: false;
      salvaged: false;
      packetId: string;
      note: string;
    }>();
    h.resetPacket.mockReset();
    h.resetPacket.mockReturnValue(deferred.promise);

    const firstPromise = route.POST(post('retry-live-duplicate'));
    await vi.waitFor(() => expect(h.resetPacket).toHaveBeenCalledTimes(1));
    const duplicate = await route.POST(post('retry-live-duplicate'));

    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: true,
      result: { inProgress: true },
    });
    deferred.resolve({
      reset: false,
      salvaged: false,
      packetId: 'packet-state-race',
      note: 'Packet generation changed before retry salvage could bind.',
    });
    expect((await firstPromise).status).toBe(409);
    expect(h.resetPacket).toHaveBeenCalledTimes(1);
  });

  it('marks the MCP retry result as an error instead of a successful reset', async () => {
    const result = await handleRetryPacket({ packetId: 'packet-state-race' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('Failed to reset packet');
  });
});
