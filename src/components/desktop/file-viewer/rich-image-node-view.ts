import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import type { NodeViewConstructor } from 'prosemirror-view';
import { markdownImageSource } from '@/lib/markdown/image-source';

function imageDom(node: ProseMirrorNode, src: string | null): HTMLImageElement {
  // The temporary node is only a display spec. The editor document and its
  // clipboard/source serializer retain the original Markdown attributes.
  const displayNode = node.type.create({ ...node.attrs, src });
  return DOMSerializer.renderSpec(document, node.type.spec.toDOM!(displayNode)).dom as HTMLImageElement;
}

export function richImageNodeView(filePath: string, repoPath: string | null): NodeViewConstructor {
  return (node) => {
    const src = String(node.attrs.src);
    const url = markdownImageSource(src, filePath, repoPath);
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
