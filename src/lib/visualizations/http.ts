import { NextResponse } from 'next/server';
import { VisualizationError } from './errors';
import { VISUALIZATION_LIMITS } from './types';

export async function visualizationBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > VISUALIZATION_LIMITS.requestBytes) throw new VisualizationError('request_too_large', 'Visualization request exceeds 600 KiB.', 413);
  if (!request.body) throw new VisualizationError('invalid_request', 'Provide a JSON body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > VISUALIZATION_LIMITS.requestBytes) { await reader.cancel(); throw new VisualizationError('request_too_large', 'Visualization request exceeds 600 KiB.', 413); }
      chunks.push(chunk.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof VisualizationError) throw error;
    throw new VisualizationError('invalid_request', 'Provide a JSON object.');
  } finally { reader.releaseLock(); }
}

export function visualizationResponse(result: unknown, status = 200): NextResponse {
  return NextResponse.json({ ok: true, result }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function visualizationFailure(error: unknown): NextResponse {
  const known = error instanceof VisualizationError;
  if (!known) console.error('[visualizations] request failed', error);
  return NextResponse.json({ ok: false, error: { code: known ? error.code : 'visualization_failed',
    message: known ? error.message : 'The visualization could not be loaded. Try again.' } },
  { status: known ? error.status : 500, headers: { 'Cache-Control': 'private, no-store' } });
}
