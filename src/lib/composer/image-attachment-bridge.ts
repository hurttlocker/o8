import { MAX_COMPOSER_IMAGES, type FileUploadHandler } from '@/lib/hooks/use-file-drop';
import { MAX_AGENT_IMAGE_BYTES, imageCorrelation, imageRequestId, validateImageAttachment, validateComposerInspection, type ImageAttachmentReceipt, type ImageAttachmentRequest } from './image-attachment';

interface Image { name: string; mimeType: string; dataUri: string; uploadRequestId?: string }
export interface ImageComposerSnapshot { element: HTMLElement | null; images: readonly Image[]; upload?: FileUploadHandler }
interface Target { id: string; current: () => ImageComposerSnapshot; live: boolean }
interface ReceiptRecord { receipt: ImageAttachmentReceipt; expires: number; target?: Target; dataUri?: string }
const targets = new Set<Target>();
const receipts = new Map<string, ReceiptRecord>();
const READ_DEADLINE_MS = 20_000;
const TERMINAL_RECEIPT_TTL_MS = 600_000;

function provenance(allow_background = false) {
  return { allow_background, document_visibility: document.visibilityState };
}
function unavailable(target: Target, allowBackground: boolean): string | undefined {
  const { element, upload } = target.current();
  const input = element?.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer="true"]');
  if (!target.live || !element?.isConnected || (input && !input.isConnected)) return 'disconnected_composer';
  if (!input) return 'inactive_composer';
  if (input.disabled || input.readOnly || input.matches(':disabled')) return 'disabled_composer';
  if (typeof upload !== 'function') return 'missing_upload_handler';
  const rect = input.getBoundingClientRect();
  const style = window.getComputedStyle(input);
  if (!(rect.width > 0 && rect.height > 0) || style.display === 'none' || style.visibility === 'hidden') return 'hidden_composer';
  if (!allowBackground && document.visibilityState === 'hidden') return 'hidden_document';
}
function available(target: Target, allowBackground: boolean): boolean {
  return unavailable(target, allowBackground) === undefined;
}
function active(allowBackground: boolean): Target | undefined {
  const matches = [...targets].filter(target => available(target, allowBackground));
  return matches.length === 1 ? matches[0] : undefined;
}
function noTargetReason(allowBackground: boolean): string {
  const reasons = [...targets].map(target => unavailable(target, allowBackground));
  if (reasons.filter(reason => reason === undefined).length > 1) return 'ambiguous_composer';
  if (reasons.includes('hidden_document')) return 'hidden_document';
  return reasons.find(reason => reason !== undefined) ?? 'missing_composer';
}
function finish(record: ReceiptRecord, code?: string) {
  record.receipt = { ...record.receipt, ...provenance(record.receipt.allow_background), status: code ? 'error' : 'completed', ...(code ? { code } : {}) };
  record.expires = Date.now() + TERMINAL_RECEIPT_TTL_MS;
  delete record.dataUri;
  delete record.target;
}
export function observeImageAttachments() {
  for (const [id, record] of receipts) {
    if (record.receipt.status !== 'pending') {
      if (Date.now() >= record.expires) receipts.delete(id);
      continue;
    }
    if (!record.target || !available(record.target, record.receipt.allow_background) || active(record.receipt.allow_background) !== record.target) { finish(record, 'target_changed'); continue; }
    if (Date.now() >= record.expires) { finish(record, 'upload_expired'); continue; }
    const matched = record.target.current().images.some(image => image.uploadRequestId === record.receipt.request_id && image.name === record.receipt.filename && image.dataUri === record.dataUri);
    if (matched) finish(record);
  }
}
function error(code: string, request?: Partial<ImageAttachmentRequest>) {
  return { status: 'error' as const, code, ...provenance(request?.allow_background), ...(request ? { request_id: request.request_id, composer_id: request.composer_id } : {}) };
}
export const composerImageBridge = {
  inspect(input: unknown = {}) {
    let options: { allow_background: boolean };
    try { options = validateComposerInspection(input); } catch { return error('invalid_schema'); }
    const target = active(options.allow_background);
    if (!target) return { ...error('no_active_composer', options), reason: noTargetReason(options.allow_background) };
    return { ...provenance(options.allow_background), status: 'ready', composer_id: target.id, image_count: target.current().images.length, max_images: MAX_COMPOSER_IMAGES, max_bytes: MAX_AGENT_IMAGE_BYTES };
  },
  status(requestId: unknown) {
    try { imageRequestId(requestId); } catch { return error('invalid_identity'); }
    observeImageAttachments();
    const receipt = receipts.get(requestId as string)?.receipt;
    return receipt ? { ...receipt, ...provenance(receipt.allow_background) } : { ...error('unknown_request'), allow_background: null, request_id: requestId };
  },
  attach(input: unknown) {
    let request: ImageAttachmentRequest;
    try { request = validateImageAttachment(input); }
    catch (failure) { return error((failure as { code?: string }).code ?? 'invalid_data', imageCorrelation(input)); }
    observeImageAttachments();
    if (receipts.has(request.request_id)) return error('duplicate_request', request);
    const target = active(request.allow_background === true);
    if (!target) return { ...error('no_active_composer', request), reason: noTargetReason(request.allow_background === true) };
    if (target.id !== request.composer_id) return error('stale_composer', request);
    if (target.current().images.length >= MAX_COMPOSER_IMAGES) return error('image_capacity', request);
    if ([...receipts.values()].some(record => record.target === target && record.receipt.status === 'pending')) return error('upload_pending', request);
    // Observation prunes terminal receipts after their TTL, even on a live
    // target. Absent status is unknown; eviction never retries a mutation.
    if (receipts.size >= 64) return error('receipt_capacity', request);
    const dataUri = `data:${request.media_type};base64,${request.data_base64}`;
    const binary = atob(request.data_base64);
    const file = new File([Uint8Array.from(binary, character => character.charCodeAt(0))], request.filename, { type: request.media_type });
    const record: ReceiptRecord = {
      receipt: { ...provenance(request.allow_background), request_id: request.request_id, composer_id: target.id, filename: request.filename, byte_length: file.size, status: 'pending' },
      target, dataUri, expires: Date.now() + READ_DEADLINE_MS,
    };
    receipts.set(request.request_id, record);
    const isCurrent = () => record.receipt.status === 'pending' && Date.now() < record.expires && available(target, record.receipt.allow_background) && active(record.receipt.allow_background) === target;
    void (async () => {
      // Magic bytes are only a format prefilter. Decode the supplied raster in
      // this renderer before invoking the normal upload handler.
      const decoder = new window.Image();
      try {
        decoder.src = dataUri;
        await decoder.decode();
        if (!decoder.naturalWidth || !decoder.naturalHeight) throw new Error('empty raster');
      } catch {
        observeImageAttachments();
        if (record.receipt.status === 'pending') finish(record, 'invalid_image');
        return;
      } finally { decoder.removeAttribute('src'); }
      observeImageAttachments();
      if (!isCurrent()) return;
      try {
        const results = await target.current().upload!([file], { isCurrent, requestId: request.request_id, backgroundAgent: record.receipt.allow_background });
        if (record.receipt.status !== 'pending') return;
        if (results?.some(result => result.status !== 'read')) finish(record, Date.now() >= record.expires ? 'upload_expired' : isCurrent() ? 'upload_failed' : 'target_changed');
        // Decode/read completion is not attachment completion. React's committed
        // image state acknowledges it through observeImageAttachments.
      } catch {
        observeImageAttachments();
        if (record.receipt.status === 'pending') finish(record, 'upload_failed');
      }
    })();
    return record.receipt;
  },
};

declare global { interface Window { __o8ComposerImages__?: typeof composerImageBridge } }
export function registerImageComposer(current: () => ImageComposerSnapshot): () => void {
  const target: Target = { id: crypto.randomUUID(), current, live: true };
  targets.add(target);
  window.__o8ComposerImages__ = composerImageBridge;
  return () => {
    target.live = false;
    targets.delete(target);
    observeImageAttachments();
    // Keep read-only receipt reconciliation available after target disposal.
  };
}
