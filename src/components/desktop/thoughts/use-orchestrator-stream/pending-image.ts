import { validateComposerImageAttachments, type ComposerImageAttachment } from '@/lib/mobile/composer-image-validation';
import type { PersistedOrchestratorPendingSend } from './pending-send-store';

/** Recover only the validated images belonging to this exact saved attempt. */
export function pendingSendImages(record: PersistedOrchestratorPendingSend): ComposerImageAttachment[] | null {
  if (!record.attachmentsRequired) return [];
  try {
    const payload = JSON.parse(record.wirePayload ?? 'null');
    if (payload?.type !== 'orchestrator-send'
      || payload.threadId !== record.threadId
      || payload.clientMessageId !== record.clientMessageId) return null;
    const images = validateComposerImageAttachments(payload.attachments);
    return images.length > 0 ? images : null;
  } catch {
    return null;
  }
}
