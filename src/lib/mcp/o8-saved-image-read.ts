import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface SavedImageTarget { thread_id: string; message_id: string; image_id: string }

/** Fixed own-document read. Inputs are data, never selectors or executable code. */
export function savedImageReadScript(target?: SavedImageTarget, pathJoin: typeof join = join): string {
  const mediaRoot = pathJoin(process.env.CORTEX_IDE_MEDIA_ROOT || join(getDataDir(), 'media'), 'orchestrator-images');
  const expectedPath = target ? pathJoin(mediaRoot, target.image_id) : null;
  return `(() => {
    const target = ${JSON.stringify(target ?? null)};
    const expectedPath = ${JSON.stringify(expectedPath)};
    const fail = code => JSON.stringify({status:'error',code});
    if (!['localhost','127.0.0.1','[::1]','tauri.localhost'].includes(location.hostname) || !['http:','https:','tauri:'].includes(location.protocol)) return fail('unsupported_document');
    if (!window.__o8ObservedDocumentId__) Object.defineProperty(window,'__o8ObservedDocumentId__',{value:crypto.randomUUID()});
    const identity = {document_id:window.__o8ObservedDocumentId__,document_visibility:document.visibilityState};
    if (!target) return JSON.stringify({status:'ready',...identity});
    const error = code => JSON.stringify({status:'error',code,...identity,...target});
    const chats = [...document.querySelectorAll('[data-o8-chat-thread][data-o8-active-chat="true"]')].filter(el => el.isConnected);
    if (chats.length !== 1) return error(chats.length ? 'ambiguous_chat' : 'no_active_chat');
    const chat = chats[0];
    if (chat.getAttribute('data-o8-chat-thread') !== target.thread_id) return error('wrong_thread');
    const messages = [...chat.querySelectorAll('[data-o8-message-id]')].filter(el => el.getAttribute('data-o8-message-id') === target.message_id);
    if (messages.length !== 1) return error(messages.length ? 'ambiguous_message' : 'missing_message');
    const images = [...messages[0].querySelectorAll('[data-o8-saved-image]')].filter(el => el.getAttribute('data-o8-saved-image') === target.image_id);
    if (images.length !== 1) return error(images.length ? 'ambiguous_image' : 'missing_image');
    const media = images[0];
    if (media.getAttribute('data-o8-media-path') !== expectedPath) return error('foreign_image');
    const imgs = [...media.querySelectorAll('img')];
    if (imgs.length > 1) return error('ambiguous_image');
    const img = imgs[0];
    const sourceState = media.getAttribute('data-o8-image-source-state');
    if (img && (!img.isConnected || (!img.getAttribute('src')?.startsWith('blob:') || img.getAttribute('src') !== media.getAttribute('data-o8-image-url')) || sourceState !== 'ready')) return error('foreign_image');
    const complete = img ? img.complete : false;
    const width = img ? img.naturalWidth : 0;
    const height = img ? img.naturalHeight : 0;
    const decoded = complete && width > 0 && height > 0 && img.currentSrc === img.getAttribute('src');
    let domVisible = !!img;
    for (let el = img; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (el.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') domVisible = false;
    }
    const geometry = !!img && img.getClientRects().length > 0;
    return JSON.stringify({status:sourceState === 'error' || (img && complete && (width === 0 || height === 0)) ? 'error' : decoded ? 'ready' : 'pending',
      ...(sourceState === 'error' || (img && complete && (width === 0 || height === 0)) ? {code:'image_decode_failed'} : {}),
      ...identity,...target,complete,natural_width:width,natural_height:height,decoded,
      dom_visible:domVisible,has_geometry:geometry,visible:domVisible && geometry && document.visibilityState === 'visible',
      url_kind:img ? 'blob' : null,source_route:'/api/mobile/media',persistence_verified:false});
  })()`;
}
