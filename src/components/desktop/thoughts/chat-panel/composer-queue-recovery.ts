import { validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import type { ComposerQueuePayload, ComposerQueueTarget } from '@/lib/orchestrator/composer-queue-types';

interface QueueAttempt { id: string; payload: ComposerQueuePayload }
const PREFIX = 'o8:composer-queue-recovery:v1:';
const LIMIT = 4_000_000;
const keyFor = (target: ComposerQueueTarget) => PREFIX + JSON.stringify(target) + ':';
const normalizeImages = (images: ComposerQueuePayload['images']) =>
  validateComposerImageAttachments(images).map(image => ({ name: image.name ?? 'Image', dataUri: image.dataUri }));
const sameDraft = (attempt: QueueAttempt, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) =>
  attempt.payload.text === draft.text && JSON.stringify(attempt.payload.images) === JSON.stringify(normalizeImages(draft.images));

function validAttempt(value: unknown): value is QueueAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<QueueAttempt>;
  return typeof entry.id === 'string' && /^queue-[A-Za-z0-9-]{8,120}$/.test(entry.id)
    && typeof entry.payload?.text === 'string' && typeof entry.payload?.wireMessage === 'string'
    && Array.isArray(entry.payload?.images) && entry.payload.images.every(image =>
      image && typeof image.name === 'string' && typeof image.dataUri === 'string')
    && Boolean(entry.payload?.routing && typeof entry.payload.routing === 'object');
}

function read(target: ComposerQueueTarget): QueueAttempt[] {
  try {
    const prefix = keyFor(target); const storage = window.localStorage; const entries: QueueAttempt[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      if (raw.length > LIMIT) throw new Error('Recovery exceeds storage limit');
      const value: unknown = JSON.parse(raw);
      if (!validAttempt(value) || key !== prefix + value.id) throw new Error('Unreadable recovery');
      entries.push(value);
    }
    if (entries.length > 20) throw new Error('Recovery exceeds queue limit');
    return entries;
  } catch {
    throw new Error('Saved Send next recovery could not be read. Keep this draft and inspect the chat before sending again.');
  }
}

export function findPendingComposerSend(target: ComposerQueueTarget, draft: Pick<ComposerQueuePayload, 'text' | 'images'>) {
  return read(target).find(attempt => sameDraft(attempt, draft));
}

export { composerQueuePayloadMatches } from '@/lib/composer/queue-payload-match';

/** Separate keys keep one completion from overwriting another window's pending send. */
export function prepareComposerSend(target: ComposerQueueTarget, payload: ComposerQueuePayload) {
  const entries = read(target);
  const existing = entries.find(attempt => sameDraft(attempt, payload));
  if (existing) return { attempt: existing, fresh: false };
  if (entries.length >= 20) throw new Error('There are 20 unconfirmed sends in this chat. Inspect the chat and retry those messages before adding more.');
  const attempt = { id: `queue-${crypto.randomUUID()}`, payload: { ...payload, images: normalizeImages(payload.images) } };
  try {
    const raw = JSON.stringify(attempt);
    if (raw.length > LIMIT) throw new Error('Recovery exceeds storage limit');
    window.localStorage.setItem(keyFor(target) + attempt.id, raw);
  } catch {
    throw new Error('Send next recovery could not be saved. Your draft is unchanged. Free browser storage before retrying.');
  }
  return { attempt, fresh: true };
}

export function confirmComposerSend(target: ComposerQueueTarget, id: string) {
  try { window.localStorage.removeItem(keyFor(target) + id); }
  catch { throw new Error('Send next recovery could not be cleared. Keep this draft and retry to check the same send.'); }
}
