// Shared by the operator host and the renderer; accepts supplied bytes only.
export const MAX_AGENT_IMAGE_BYTES = 1024 * 1024;
export const MAX_AGENT_IMAGE_BASE64 = 4 * Math.ceil(MAX_AGENT_IMAGE_BYTES / 3);
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export interface ImageAttachmentRequest {
  composer_id: string;
  request_id: string;
  filename: string;
  media_type: typeof IMAGE_MEDIA_TYPES[number];
  data_base64: string;
  allow_background?: boolean;
}
export interface ImageAttachmentReceipt {
  request_id: string;
  composer_id: string;
  status: 'pending' | 'completed' | 'error';
  allow_background: boolean;
  document_visibility: string;
  code?: string;
  filename?: string;
  byte_length?: number;
}
export function imageError(code: string): never {
  throw Object.assign(new Error(code), { code });
}
export function imageBackground(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') imageError('invalid_schema');
  return value === true;
}
export function validateComposerInspection(input: unknown): { allow_background: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) imageError('invalid_schema');
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(key => key !== 'allow_background')) imageError('invalid_schema');
  return { allow_background: imageBackground(args.allow_background) };
}
export function imageRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) imageError('invalid_identity');
  return value;
}
export function imageCorrelation(input: unknown): Partial<ImageAttachmentRequest> {
  const ids: Partial<ImageAttachmentRequest> = {};
  if (input && typeof input === 'object') {
    if (typeof (input as Record<string, unknown>).allow_background === 'boolean') ids.allow_background = (input as Record<string, unknown>).allow_background as boolean;
    for (const key of ['request_id', 'composer_id'] as const) {
      try { ids[key] = imageRequestId((input as Record<string, unknown>)[key]); } catch { /* Invalid identities are not echoed. */ }
    }
  }
  return ids;
}
export function validateImageAttachment(input: unknown): ImageAttachmentRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) imageError('invalid_schema');
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(key => !['composer_id', 'request_id', 'filename', 'media_type', 'data_base64', 'allow_background'].includes(key))) imageError('invalid_schema');
  imageBackground(args.allow_background);
  imageRequestId(args.composer_id);
  imageRequestId(args.request_id);
  if (typeof args.filename !== 'string' || args.filename.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(args.filename)) imageError('invalid_filename');
  const extensions: Record<string, RegExp> = { 'image/png': /\.png$/i, 'image/jpeg': /\.jpe?g$/i, 'image/gif': /\.gif$/i, 'image/webp': /\.webp$/i };
  if (typeof args.media_type !== 'string' || !IMAGE_MEDIA_TYPES.includes(args.media_type as ImageAttachmentRequest['media_type']) || !extensions[args.media_type].test(args.filename)) imageError('invalid_media_type');
  if (typeof args.data_base64 !== 'string' || !args.data_base64.length || args.data_base64.length > MAX_AGENT_IMAGE_BASE64) imageError('invalid_size');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_base64) || args.data_base64.length % 4 !== 0) imageError('invalid_data');
  let bytes: string;
  try { bytes = atob(args.data_base64); } catch { imageError('invalid_data'); }
  if (!bytes.length || bytes.length > MAX_AGENT_IMAGE_BYTES) imageError('invalid_size');
  if (btoa(bytes) !== args.data_base64) imageError('invalid_data');
  // Format prefilter only; the renderer must decode before normal upload.
  const starts = (signature: number[]) => signature.every((byte, index) => bytes.charCodeAt(index) === byte);
  const matches = args.media_type === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : args.media_type === 'image/jpeg' ? starts([255, 216, 255])
      : args.media_type === 'image/gif' ? /^GIF8[79]a/.test(bytes)
        : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
  if (!matches) imageError('invalid_data');
  return args as unknown as ImageAttachmentRequest;
}
