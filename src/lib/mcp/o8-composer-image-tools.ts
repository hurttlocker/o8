import { IMAGE_MEDIA_TYPES, MAX_AGENT_IMAGE_BASE64, imageCorrelation, imageRequestId, validateImageAttachment, validateComposerInspection } from '@/lib/composer/image-attachment';
import type { O8WebviewClient } from './o8-webview-client';

const backgroundSchema = { type: 'boolean', description: 'Explicit per-call opt-in to a document-hidden composer. Retains active identity, DOM visibility/layout and upload guards; never shows/focuses a window. Omitted/false requires a visible document.' };

export const COMPOSER_IMAGE_TOOLS = [
  {
    name: 'o8_view_inspect_composer',
    description: 'Read the active composer identity (visible document by default, allow_background opt-in) and image capacity. No file reads, picker or message send. Retain composer_id for an image attachment.',
    inputSchema: { type: 'object', properties: { allow_background: backgroundSchema }, required: [], additionalProperties: false },
  },
  {
    name: 'o8_view_attach_image',
    description: 'Attach explicitly supplied image bytes to the inspected active composer through its normal upload handler. Maximum 1 MiB; PNG/JPEG/GIF/WebP only, decoded in the renderer before upload. Never sends. Returns a correlated pending/completed/error receipt. Never retry a mutation after timeout/disconnect; use image_attachment_status with request_id. allow_background is a per-call opt-in; receipts retain that mode during status reconciliation. A completed receipt proves composer attachment only, not chat send or persistence.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        allow_background: backgroundSchema,
        composer_id: { type: 'string', minLength: 8, maxLength: 80 },
        request_id: { type: 'string', minLength: 8, maxLength: 80, description: 'Unique caller correlation ID; never reuse for a new attachment.' },
        filename: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]*$', description: 'ASCII filename only, no path; extension must match media_type.' },
        media_type: { type: 'string', enum: [...IMAGE_MEDIA_TYPES] },
        data_base64: { type: 'string', minLength: 1, maxLength: MAX_AGENT_IMAGE_BASE64 },
      },
      required: ['composer_id', 'request_id', 'filename', 'media_type', 'data_base64'],
    },
  },
  {
    name: 'o8_view_image_attachment_status',
    description: 'Read a previously requested image attachment receipt by request_id. Read-only; does not attach or retry. Completed/error receipts expire after ten minutes, including on the active composer. Missing receipt means the outcome is unknown; inspect the composer before any new request.',
    inputSchema: { type: 'object', properties: { request_id: { type: 'string', minLength: 8, maxLength: 80 } }, required: ['request_id'], additionalProperties: false },
  },
];
export function createComposerImageHandlers(getClient: () => O8WebviewClient) {
  async function run(action: () => Promise<unknown>, args?: Record<string, unknown>) {
    try { const data = await action(); return { ...((data as { status?: string })?.status === 'error' ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(data) }] }; }
    catch (error) {
      const code = (error as { code?: string })?.code ?? 'bridge_unavailable';
      const uncertain = args && !code.startsWith('invalid_');
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', code: uncertain ? 'outcome_unknown' : code, ...imageCorrelation(args), ...(uncertain ? { next: 'Read image_attachment_status; never retry the attachment automatically' } : {}) }) }] };
    }
  }
  return {
    o8_view_inspect_composer: (args: Record<string, unknown>) => run(async () => {
      const options = validateComposerInspection(args);
      return getClient().inspectImageComposer(options);
    }),
    o8_view_attach_image: (args: Record<string, unknown>) => run(async () => {
      const payload = validateImageAttachment(args);
      return getClient().attachComposerImage(payload);
    }, args),
    o8_view_image_attachment_status: (args: Record<string, unknown>) => run(async () => {
      if (Object.keys(args).some(key => key !== 'request_id')) throw Object.assign(new Error('invalid_schema'), { code: 'invalid_schema' });
      const requestId = imageRequestId(args.request_id);
      return getClient().imageAttachmentStatus(requestId);
    }),
  };
}
