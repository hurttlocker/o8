import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #1481 — review-continuation setting, real route round-trip.
 *
 * The ws-server's queueReviewContinuation gate reads
 * resolveReviewContinuationSync() — the same file-backed resolver this test
 * drives through the ACTUAL operator-defaults route. Default must be ON (the
 * issue: unattended fleets park at review-ready out of the box), and an
 * operator opt-out must persist and be visible to the exact resolver the
 * supervisor path reads.
 */
const dir = mkdtempSync(join(os.tmpdir(), 'o8-review-cont-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_DATA_DIR = dir;

const { POST, GET } = await import('@/app/api/panel/operator-defaults/route');
const { resolveReviewContinuationSync } = await import('@/lib/operator/defaults');

function postReq(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('#1481 — review continuation toggle, real route round-trip', () => {
  it('defaults ON, opt-out persists through the real POST, and the supervisor resolver sees it', async () => {
    expect(resolveReviewContinuationSync()).toBe(true);

    const res = await POST(postReq({ reviewContinuation: false }));
    const payload = await res.json();
    expect(res.status).toBe(200);
    expect(payload.values.reviewContinuation).toBe(false);
    expect(payload.sources.reviewContinuation).toBe('file');

    // The exact resolver queueReviewContinuation gates on.
    expect(resolveReviewContinuationSync()).toBe(false);

    const getRes = await GET();
    const getPayload = await getRes.json();
    expect(getPayload.values.reviewContinuation).toBe(false);

    const restore = await POST(postReq({ reviewContinuation: true }));
    expect((await restore.json()).values.reviewContinuation).toBe(true);
    expect(resolveReviewContinuationSync()).toBe(true);
  });

  it('rejects a non-boolean value through the real route', async () => {
    const res = await POST(postReq({ reviewContinuation: 'yes' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
