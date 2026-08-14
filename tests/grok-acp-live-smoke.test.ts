import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.O8_LIVE_GROK_ACP === '1';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-grok-acp-live-'));
const repoRoot = path.join(process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8'), 'grok-acp-live-repo');

async function waitForText(
  read: () => Promise<Array<{ role: string; text: string }>>,
  expected: string,
) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const transcript = await read();
    if (transcript.some((entry) => entry.role === 'assistant' && entry.text.includes(expected))) {
      return transcript;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for live Grok ACP text: ${expected}`);
}

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-q', repoRoot]);
  process.env.O8_OWNED_GROK_ROOT = path.join(tempRoot, 'owned');
  delete process.env.O8_GROK_BIN;
  const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
  invalidateCliCache('grok');
});

afterAll(async () => {
  delete process.env.O8_OWNED_GROK_ROOT;
  const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
  invalidateCliCache('grok');
  rmSync(tempRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)('Grok installed ACP live smoke', () => {
  it('runs Grok 4.6 and cold-resumes the same upstream session', async () => {
    const { grokRuntime } = await import('@/lib/runtimes/grok');
    const launched = await grokRuntime.launch({
      cwd: repoRoot,
      prompt: 'Reply exactly GROK-46-O8-ACP-OK.',
      clientMutationId: 'grok-live-acp-smoke',
      model: 'grok-4.6',
    });
    expect(launched).toMatchObject({ ok: true });
    const sessionKey = launched.sessionKey!;
    await waitForText(() => grokRuntime.readTranscript(sessionKey), 'GROK-46-O8-ACP-OK');
    await expect(grokRuntime.getTelemetry?.(sessionKey)).resolves.toMatchObject({
      model: 'grok-4.6',
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      estimatedCostUsd: expect.any(Number),
    });

    await expect(grokRuntime.interrupt(sessionKey)).resolves.toMatchObject({ ok: true });
    await expect(grokRuntime.resume(sessionKey, 'Reply exactly GROK-46-O8-RESUME-OK.')).resolves.toMatchObject({ ok: true });
    await waitForText(() => grokRuntime.readTranscript(sessionKey), 'GROK-46-O8-RESUME-OK');

    const { archiveOwnedGrokSession } = await import('@/lib/grok/owned');
    await expect(archiveOwnedGrokSession(sessionKey)).resolves.toMatchObject({ archived: true });
  }, 240_000);
});
