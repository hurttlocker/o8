import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Development-profile opt-in only. This transport has no gateway/provider dependencies. */
export function localVoicePreview(): 'enabled' | 'disabled' | 'invalid' {
  if (process.env.NODE_ENV !== 'development') return 'disabled';
  let fd: number;
  try { fd = openSync(join(getDataDir(), 'managed-voice-preview.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'disabled' : 'invalid'; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) return 'invalid';
    const value = JSON.parse(readFileSync(fd, 'utf8')) as { version?: number; expiresAt?: number };
    return value.version === 1 && Number.isSafeInteger(value.expiresAt)
      && value.expiresAt! > Date.now() && value.expiresAt! <= Date.now() + 24 * 60 * 60_000 ? 'enabled' : 'invalid';
  } catch { return 'invalid'; }
  finally { closeSync(fd); }
}
const sessions = new Map<string, { owner: string; binding: string; closed: boolean; expiresAt: number }>();

/** Exercise local capture and presentation; never transcribe, dispatch work or spend. */
export function previewVoiceRequest(body: Record<string, unknown>, owner: string): Response {
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  if (localVoicePreview() !== 'enabled') return reply({ error: 'local_voice_preview_expired' }, 503);
  for (const [id, record] of sessions) if (record.expiresAt < Date.now()) sessions.delete(id);
  if (body.action === 'start') {
    if (typeof body.binding !== 'string' || !body.binding || body.binding.length > 2000) return reply({ error: 'invalid_binding' }, 400);
    if (sessions.size >= 32) return reply({ error: 'local_voice_preview_capacity' }, 429);
    const id = randomUUID();
    sessions.set(id, { owner, binding: body.binding, closed: false, expiresAt: Date.now() + 60 * 60_000 });
    return reply({ id, transport: 'local-preview' });
  }
  const record = sessions.get(typeof body.id === 'string' ? body.id : '');
  if (!record || record.owner !== owner || record.binding !== body.binding) return reply({ error: 'session_not_found' }, 404);
  if (body.action === 'close') { record.closed = true; return reply({ closing: true }); }
  if (body.action === 'poll' && Number.isSafeInteger(body.after) && Number(body.after) >= 0) {
    return reply({ events: record.closed && Number(body.after) < 1 ? [{ cursor: 1, event: { type: 'session.closed', event_id: `${body.id}:closed` } }] : [] });
  }
  if (body.action === 'event') return reply({ accepted: true, simulated: true });
  return reply({ error: 'invalid_action' }, 400);
}
