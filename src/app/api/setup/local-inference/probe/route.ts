import { NextResponse } from 'next/server';

import {
  normalizeLocalInferenceBaseUrl,
  probeLocalInference,
} from '@/lib/cortex/qa/llm/inference-route';
import { resolveLocalInferenceBaseUrlSync } from '@/lib/operator/defaults';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function isLoopbackProbeBase(raw: string): boolean {
  try {
    const url = new URL(normalizeLocalInferenceBaseUrl(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '::1'
      || host === '[::1]';
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedBase = url.searchParams.get('base')?.trim() ?? '';
  if (requestedBase && !isLoopbackProbeBase(requestedBase)) {
    return response({
      running: false,
      models: [],
      error: 'Only loopback local inference probe URLs are allowed.',
    }, 400);
  }

  const baseUrl = requestedBase || resolveLocalInferenceBaseUrlSync().trim();
  if (!baseUrl) {
    return response({ running: false, models: [] });
  }
  if (!isLoopbackProbeBase(baseUrl)) {
    return response({
      running: false,
      models: [],
      error: 'Only loopback local inference probe URLs are allowed.',
    }, 400);
  }

  const result = await probeLocalInference(baseUrl);
  return response(result);
}
