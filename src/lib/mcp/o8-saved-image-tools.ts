import type { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import type { SavedImageTarget } from '@/lib/mcp/o8-saved-image-read';

const identity = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_.:-]+$' };
const documentId = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
export const SAVED_IMAGE_TOOLS = [
  {
    name: 'o8_view_saved_image',
    description: 'Read the exact active thread/message saved composer upload renderer. image_id is the content-addressed upload basename (SHA-256 plus raster extension), not a URL/path. Reports actual complete and natural dimensions plus DOM/document visibility. DOM presence or decode does not prove backend persistence. Never fetches, focuses, sends or attaches.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { thread_id: identity, message_id: identity, image_id: { type: 'string', pattern: '^[a-f0-9]{64}\\.(png|jpg|gif|webp)$' } }, required: ['thread_id', 'message_id', 'image_id'] },
  },
  {
    name: 'o8_view_hard_reload',
    description: 'Fixed main app document reload, or read-only document identity observation. Observe first; reload requires that document_id. Dispatch returns pending, never completed. Observe afterward with the previous document_id to detect replacement; this does not prove chat persistence or attribute the replacement uniquely to this call. Timeout/disconnect is unknown: never retry automatically. No URL, code, window, OS or focus arguments.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { operation: { type: 'string', enum: ['observe', 'reload'] }, document_id: documentId }, required: ['operation'] },
  },
];
function invalid(): never { throw Object.assign(new Error('invalid_schema'), { code: 'invalid_schema' }); }
function plain(args: Record<string, unknown>, keys: string[]) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) || Object.keys(args).some(key => !keys.includes(key))) invalid();
}
export function parseSavedImageTarget(args: Record<string, unknown>): SavedImageTarget {
  plain(args, ['thread_id', 'message_id', 'image_id']);
  for (const key of ['thread_id', 'message_id']) if (typeof args[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(args[key])) invalid();
  if (typeof args.image_id !== 'string' || !/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(args.image_id)) invalid();
  return args as unknown as SavedImageTarget;
}
export function parseHardReload(args: Record<string, unknown>): { operation: 'observe' | 'reload'; document_id?: string } {
  plain(args, ['operation', 'document_id']);
  if (typeof args.operation !== 'string' || !['observe', 'reload'].includes(args.operation)) invalid();
  if (args.document_id !== undefined && (typeof args.document_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.document_id))) invalid();
  if (args.operation === 'reload' && !args.document_id) invalid();
  return args as { operation: 'observe' | 'reload'; document_id?: string };
}
export function createSavedImageHandlers(getClient: () => O8WebviewClient) {
  const run = async (task: () => Promise<Record<string, unknown>>) => {
    let data: Record<string, unknown>;
    try { data = await task(); }
    catch (error) { data = { status: 'error', code: (error as { code?: string }).code ?? 'observation_unavailable' }; }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], ...(['error', 'unknown'].includes(String(data.status)) ? { isError: true } : {}) };
  };
  return {
    o8_view_saved_image: (args: Record<string, unknown>) => run(() => getClient().inspectSavedImage(parseSavedImageTarget(args))),
    o8_view_hard_reload: (args: Record<string, unknown>) => run(() => getClient().hardReload(parseHardReload(args))),
  };
}
