import { composerBackendSupportsImages } from '@/lib/mobile/composer-image-validation';
import { buildVisualInstructionPayload } from './visual-instruction';
import type { VisualInstructionDraft } from './visual-draft-store';

export class VisualInstructionDeliveryError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); this.name = 'VisualInstructionDeliveryError'; }
}

export const VISUAL_REQUEST_MARKER = '[o8-visual-instruction]';

/** Stable draft id is also the idempotency key. A lost reply never chooses another conversation. */
export async function submitVisualInstruction(draft: VisualInstructionDraft, transport: typeof fetch = fetch) {
  let result;
  try { result = buildVisualInstructionPayload(draft.request); } catch (error) { throw new VisualInstructionDeliveryError(error instanceof Error ? error.message : String(error)); }
  if (!composerBackendSupportsImages(draft.template.routing.backend)) throw new VisualInstructionDeliveryError('The selected runtime cannot receive these images. The visual draft is retained.');
  const template = draft.template.wireMessage;
  if (template.split(VISUAL_REQUEST_MARKER).length !== 2) throw new VisualInstructionDeliveryError('The captured send route is incomplete. Keep the draft and select its conversation.');
  const payload = { ...draft.template, text: result.text, wireMessage: template.replace(VISUAL_REQUEST_MARKER, () => result.wireMessage), images: result.images };
  if (payload.wireMessage.length > 250_000) throw new VisualInstructionDeliveryError('This visual request exceeds the chat limit. Shorten the instruction or use fewer frames.');
  const response = await transport('/api/orchestrator/composer-queue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...draft.request.target, id: `visual-${draft.request.id}`, intent: 'send-next', payload }) });
  const body = await response.json().catch(() => null) as { item?: { id: string; threadId: string; repoPath: string; status: string }; error?: string } | null;
  if (!response.ok) throw new VisualInstructionDeliveryError(body?.error || 'The visual request was not accepted. Its draft is retained.');
  if (body?.item?.id !== `visual-${draft.request.id}` || body.item.threadId !== draft.request.target.threadId) {
    throw new VisualInstructionDeliveryError('Delivery was not confirmed for this conversation. Reconcile before retrying.', true);
  }
  return body.item;
}
