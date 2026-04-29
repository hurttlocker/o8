/**
 * #800 — POST /api/panel/diagnostics/run-demo
 *
 * Triggers the in-app demo sequence runner that drives the live o8 webview
 * through the golden demo path (navigate → orchestrator → quick action),
 * capturing screenshots and assertions at each step.
 *
 * Auth: gated globally by src/middleware.ts on loopback origin or the panel
 * bearer token. No body required.
 *
 * Behaviour:
 *   - 200 + { ok: true, result } when the run completes (pass or fail).
 *   - 504 + { ok: false, error, result } when the 60s overall budget hits;
 *     `result` still contains everything we captured before timing out.
 *   - 500 + { ok: false, error } only for unrecoverable infra failures
 *     (e.g. the data dir cannot be written to).
 *
 * Never throws — always returns a structured response.
 */

import { NextResponse } from 'next/server';
import { runDemoSequence, type DemoRunResult } from '@/lib/diagnostics/demo-sequence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };
const OVERALL_TIMEOUT_MS = 60_000;

function jsonResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE_HEADERS });
}

export async function POST(): Promise<NextResponse> {
  try {
    const result: DemoRunResult = await runDemoSequence({ timeoutMs: OVERALL_TIMEOUT_MS });
    if (result.truncated) {
      return jsonResponse(
        {
          ok: false,
          error: `Demo sequence exceeded ${OVERALL_TIMEOUT_MS}ms — partial results returned.`,
          result,
        },
        504,
      );
    }
    return jsonResponse({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      { ok: false, error: `Failed to run demo sequence: ${message}` },
      500,
    );
  }
}
