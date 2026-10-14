import { useCallback, useEffect, useRef, useState } from 'react';
import type { useWorkspaceChatPane } from './useWorkspaceChatPane';
import type { useThoughtsComposerAttachments, ThoughtsAttachedImage } from '@/components/desktop/thoughts/chat-panel/useThoughtsComposerAttachments';

export function useWorkspaceComposerSubmit(chat: ReturnType<typeof useWorkspaceChatPane>, attachments: ReturnType<typeof useThoughtsComposerAttachments>, repoPath?: string, enabled = true) {
  const busy = useRef(false);
  const upload = useRef<AbortController | null>(null);
  const uploads = useRef(new WeakMap<ThoughtsAttachedImage, { repoPath: string; path: string }>());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => upload.current?.abort(), [repoPath, chat.tabId, chat.normalizedSessionKey, enabled]);
  const submit = useCallback(() => {
    if (!enabled || busy.current || chat.sending) return;
    const images = [...attachments.attachedImages];
    const draft = chat.draft;
    const context = [...chat.queuedContextCards];
    if (!draft.trim() && !context.length && !images.length) return;
    busy.current = true; setSubmitting(true); setError(null);
    const controller = new AbortController(); upload.current = controller;
    void (async () => {
      try {
        if (images.length && !repoPath) throw new Error('Choose a repository before sending images. Your draft and attachments are still here.');
        const refs: string[] = [];
        for (const image of images) {
          const cached = uploads.current.get(image);
          let path = cached && cached.repoPath === repoPath ? cached.path : undefined;
          if (!path) {
            const response = await fetch(`/api/repo-spec/asset?repoPath=${encodeURIComponent(repoPath!)}`, {
              method: 'POST', signal: controller.signal, headers: { 'Content-Type': image.mimeType, 'x-filename': encodeURIComponent(image.name) },
              body: dataUriToBlob(image.dataUri, image.mimeType),
            });
            const value = await response.json().catch(() => null) as { ok?: boolean; relPath?: string } | null;
            if (controller.signal.aborted) return;
            if (!response.ok || !value?.ok || !value.relPath) throw new Error('An image could not upload. Your draft and attachments are still here. Retry when connected.');
            path = value.relPath; uploads.current.set(image, { repoPath: repoPath!, path });
          }
          refs.push(`![${image.name.replace(/[\[\]\n\r]/g, '')}](${path})`);
        }
        const text = [...context.map(card => card.text.trim()), draft.trim(), ...refs].filter(Boolean).join('\n\n');
        if (controller.signal.aborted) return;
        const outcome = await chat.sendText(text);
        if (outcome !== 'accepted' && outcome !== 'queued') {
          setError(outcome === 'unconfirmed' ? 'Delivery unconfirmed. Check the transcript before sending again.' : 'Message not accepted. Your draft and attachments are still here.');
          return;
        }
        chat.setDraft(current => current === draft ? '' : current);
        context.forEach(card => chat.handleRemoveQueuedContext(card.id));
        attachments.consumeAttachedImages(images);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Message not sent. Your draft and attachments are still here.'); }
      finally { busy.current = false; upload.current = null; setSubmitting(false); }
    })();
  }, [attachments, chat, enabled, repoPath]);
  return { submit, submitting, error };
}

function dataUriToBlob(dataUri: string, fallbackMime: string): Blob {
  const comma = dataUri.indexOf(',');
  if (comma < 0) throw new Error('The image could not be read. Remove it or add it again.');
  const mime = dataUri.slice(0, comma).match(/data:([^;]+)/)?.[1] ?? fallbackMime;
  const decoded = atob(dataUri.slice(comma + 1));
  return new Blob([Uint8Array.from(decoded, character => character.charCodeAt(0))], { type: mime });
}
