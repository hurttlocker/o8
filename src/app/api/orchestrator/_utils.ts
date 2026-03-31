import { NextResponse } from 'next/server';

const JSON_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };
const LOG_PREFIX = '[mcp-operator]';

export function operatorSuccess<T>(result: T, status = 200) {
  return NextResponse.json({ ok: true, result }, {
    status,
    headers: JSON_HEADERS,
  });
}

export function operatorError(code: string, message: string, status = 500, details?: unknown) {
  if (details === undefined) {
    console.error(`${LOG_PREFIX} ${code}: ${message}`);
  } else {
    console.error(`${LOG_PREFIX} ${code}: ${message}`, details);
  }

  return NextResponse.json({
    ok: false,
    error: {
      code,
      message,
    },
  }, {
    status,
    headers: JSON_HEADERS,
  });
}

export async function parseJsonBody(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
