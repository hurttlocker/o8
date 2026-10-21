import 'server-only';

import { randomBytes } from 'node:crypto';
import { previewBindingCurrent, type PreviewBinding } from './preview-authority';
import { PREVIEW_MAX_BYTES, PREVIEW_REQUEST_MS, type RemotePreviewRequest, type RemotePreviewResponse } from './preview-contract';

interface PendingRequest {
  binding: PreviewBinding;
  request: RemotePreviewRequest;
  delivered: boolean;
  settle: (result: RemotePreviewResponse | null) => void;
}

// Only bounded transient HTTP reads live here. Task/claim/service authority is durable.
const globalRelay = globalThis as typeof globalThis & { __o8PreviewRelay?: Map<string, PendingRequest> };
const pending = globalRelay.__o8PreviewRelay ??= new Map<string, PendingRequest>();

export async function requestPreview(binding: PreviewBinding, path: string, method: 'GET' | 'HEAD', signal: AbortSignal) {
  if (pending.size >= 32 || signal.aborted || !previewBindingCurrent(binding)) return null;
  const id = randomBytes(24).toString('hex');
  return new Promise<RemotePreviewResponse | null>((resolve) => {
    const finish = (result: RemotePreviewResponse | null) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      pending.delete(id);
      resolve(result);
    };
    const abort = () => finish(null);
    const timeout = setTimeout(abort, PREVIEW_REQUEST_MS);
    pending.set(id, { binding, request: { id, service: binding.service, path, method }, delivered: false, settle: finish });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function takePreviewRequest(teamId: string, jobId: string, attempt: number): RemotePreviewRequest | null {
  for (const item of pending.values()) {
    if (item.binding.teamId !== teamId || item.binding.jobId !== jobId || item.binding.attempt !== attempt || item.delivered) continue;
    if (!previewBindingCurrent(item.binding)) { item.settle(null); continue; }
    item.delivered = true;
    return item.request;
  }
  return null;
}

export function answerPreviewRequest(teamId: string, jobId: string, attempt: number, result: RemotePreviewResponse): boolean {
  const item = pending.get(result.id);
  if (!item?.delivered || item.binding.teamId !== teamId || item.binding.jobId !== jobId || item.binding.attempt !== attempt) return false;
  if (!previewBindingCurrent(item.binding)) { item.settle(null); return false; }
  if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599
    || typeof result.contentType !== 'string' || result.contentType.length > 256 || /[\r\n\x00]/.test(result.contentType)
    || typeof result.body !== 'string' || result.body.length > Math.ceil(PREVIEW_MAX_BYTES / 3) * 4
    || result.body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.body)) return false;
  const bytes = Buffer.from(result.body, 'base64');
  if (bytes.length > PREVIEW_MAX_BYTES || bytes.toString('base64') !== result.body) return false;
  item.settle(result);
  return true;
}
