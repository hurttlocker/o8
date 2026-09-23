import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { MAX_PACKAGE_BYTES } from './packages';
import { CustomizeError } from './storage';

export async function readCustomizeBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new CustomizeError('invalid_body', 'Request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PACKAGE_BYTES) {
        await reader.cancel();
        throw new CustomizeError('too_large', 'This file is too large. The limit is 512 KB.', 413);
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CustomizeError('invalid_json', 'The file is not valid JSON.'); }
  } finally { reader.releaseLock(); }
}
export function customizeFailure(error: unknown) {
  if (error instanceof CustomizeError) return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ ok: false, error: { code: 'invalid_input', message: 'Check the format and required fields. Only instruction skills are supported; scripts, hooks, and connections cannot be installed here.' } }, { status: 400 });
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return NextResponse.json({ ok: false, error: { code: 'not_found', message: 'This installation or location no longer exists. Refresh and try again.' } }, { status: 404 });
  return NextResponse.json({ ok: false, error: { code: 'storage_error', message: 'Could not save or read this customization. Check that its folder is writable and try again.' } }, { status: 500 });
}
