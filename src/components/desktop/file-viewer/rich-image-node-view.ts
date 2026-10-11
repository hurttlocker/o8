import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import type { NodeViewConstructor } from 'prosemirror-view';

/** Preserve URL image sources instead of resolving them as workspace assets. */
function isUrlImage(src: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src);
}

function localImageUrl(src: string, filePath: string, repoPath: string | null): string | null {
  // Markdown URLs are URL-encoded, while the asset reader accepts filesystem
  // paths. Decode once, before encoding the route's query parameter. Leave
  // containment, registration, and symlink checks to the existing asset reader.
  const path = src.split(/[?#]/, 1)[0];
  if (!path) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const directory = filePath.slice(0, filePath.lastIndexOf('/') + 1);
  const params = new URLSearchParams({ path: decoded.startsWith('/') ? decoded : directory + decoded });
  if (repoPath) params.set('workspace', repoPath);
  const fragment = src.includes('#') ? src.slice(src.indexOf('#')) : '';
  return `/api/panel/file-asset?${params.toString()}${fragment}`;
}

function imageDom(node: ProseMirrorNode, src: string | null): HTMLImageElement {
  // The temporary node is only a display spec. The editor document and its
  // clipboard/source serializer retain the original Markdown attributes.
  const displayNode = node.type.create({ ...node.attrs, src });
  return DOMSerializer.renderSpec(document, node.type.spec.toDOM!(displayNode)).dom as HTMLImageElement;
}

export function richImageNodeView(filePath: string, repoPath: string | null): NodeViewConstructor {
  return (node) => {
    const src = String(node.attrs.src);
    const url = isUrlImage(src) ? src : localImageUrl(src, filePath, repoPath);
    const dom = document.createElement('span');
    dom.contentEditable = 'false';
    dom.style.cssText = 'display:inline-block;max-width:100%;vertical-align:middle;';
    const image = imageDom(node, url);
    const imageDisplay = image.style.display;
    const fallback = document.createElement('span');
    const label = `Image unavailable: ${String(node.attrs.alt || src || 'image')}`;
    fallback.textContent = label;
    fallback.title = label;
    fallback.hidden = true;
    fallback.style.cssText = [
      'font-family:var(--font-sans-system)',
      'font-size:12px',
      'font-weight:300',
      'line-height:16px',
      'color:var(--t-text-muted)',
      'display:none',
      'max-width:100%',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    const showUnavailable = () => {
      image.hidden = true;
      image.style.display = 'none';
      fallback.hidden = false;
      fallback.style.display = 'inline-block';
      dom.setAttribute('role', 'img');
      dom.setAttribute('aria-label', label);
    };
    const showAvailable = () => {
      image.hidden = false;
      image.style.display = imageDisplay;
      fallback.hidden = true;
      fallback.style.display = 'none';
      dom.removeAttribute('role');
      dom.removeAttribute('aria-label');
    };
    image.addEventListener('error', showUnavailable);
    image.addEventListener('load', showAvailable);
    dom.append(image, fallback);
    if (!url) showUnavailable();
    return {
      dom,
      // Error feedback is presentation, never an editor transaction.
      ignoreMutation: () => true,
      destroy: () => {
        image.removeEventListener('error', showUnavailable);
        image.removeEventListener('load', showAvailable);
      },
    };
  };
}
