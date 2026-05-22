/*
 * spec-image-widget — inline image RENDER for the o8.md editor (P2).
 *
 * A standalone StateField (NOT folded into buildAll's CriticMarkup matchers —
 * kept fully separate so that logic is untouched) that block-replaces each
 * pure-image line with a small fixed-height thumbnail. The width×height parked
 * in the markdown title at upload (![alt](src "WxH")) lets the box reserve its
 * size BEFORE the bytes load — so an image landing late never shifts the
 * margin-note review rail (recompute() assumes stable line heights). Click opens
 * a lightbox mirroring ChatImage. Repo-relative srcs (o8-assets/…) resolve
 * through the path-jailed /api/panel/file-asset reader; http(s)/data srcs pass
 * through. repoPath arrives via a Facet so it tracks repo switches without
 * rebuilding the editor.
 */

import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import { StateField, Facet, Compartment, type Range, type Extension } from '@codemirror/state';

// Whole-line image: ![alt](src) or ![alt](src "WxH"), nothing else on the line.
// A line carrying a CriticMarkup marker after the image fails the trailing $
// anchor and is left to buildAll — so this matcher is purely additive.
const PURE_IMAGE_RE = /^[ \t]*!\[([^\]]*)\]\(([^)]+)\)[ \t]*$/;

const THUMB_H = 120; // small, chat-chip-ish; tune to taste

export interface ParsedSpecImage {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
}

function parsePureImageLine(line: string): ParsedSpecImage | null {
  const m = PURE_IMAGE_RE.exec(line);
  if (!m) return null;
  const inner = m[2].trim();
  // <src> optionally followed by a "WxH" title (the only title form we author).
  const tm = /^(\S+)(?:\s+"(\d+)x(\d+)")?$/.exec(inner);
  const src = (tm ? tm[1] : inner).trim();
  // Skip the in-flight upload placeholder (#o8-upload-…) and any non-image anchor.
  if (!src || src.startsWith('#')) return null;
  return {
    src,
    alt: m[1],
    width: tm && tm[2] ? Number(tm[2]) : null,
    height: tm && tm[3] ? Number(tm[3]) : null,
  };
}

function resolveSpecImageUrl(src: string, repoPath: string | null): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  if (!repoPath) return src; // repo-relative ref but no repo to resolve against
  return `/api/panel/file-asset?workspace=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(src)}`;
}

// Raw-DOM lightbox (the editor widget is DOM, not React) — mirrors ChatImage:
// dark blurred backdrop, click/Esc to close.
function openSpecLightbox(url: string, alt: string): void {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center;'
    + 'background:rgba(0,0,0,0.75); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); cursor:zoom-out;';
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  img.style.cssText = 'max-width:92vw; max-height:90vh; border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,0.5);';
  img.onclick = (e) => e.stopPropagation();
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  function close(): void { overlay.remove(); document.removeEventListener('keydown', onKey); }
  overlay.onclick = close;
  document.addEventListener('keydown', onKey);
  overlay.appendChild(img);
  document.body.appendChild(overlay);
}

// Right-click menu on a thumbnail. Hardcoded dark popover (transient overlay —
// themed --t-* tokens render invisible on a dark menu in light mode).
function openSpecImageMenu(x: number, y: number, url: string, name: string): void {
  document.querySelectorAll('[data-o8-spec-img-menu]').forEach((el) => el.remove());
  const menu = document.createElement('div');
  menu.setAttribute('data-o8-spec-img-menu', '');
  menu.style.cssText =
    `position:fixed; left:${x}px; top:${y}px; z-index:99998; min-width:148px; padding:5px;`
    + 'border-radius:10px; background:rgba(34,38,45,0.98); border:1px solid rgba(255,255,255,0.12);'
    + 'box-shadow:0 10px 30px rgba(0,0,0,0.35); font-family:Inter, system-ui, sans-serif; font-size:12.5px;';
  const item = document.createElement('button');
  item.type = 'button';
  item.textContent = 'Add to chat';
  item.style.cssText =
    'display:block; width:100%; text-align:left; padding-top:7px; padding-bottom:7px; padding-left:10px;'
    + 'padding-right:10px; border-radius:7px; border:none; background:transparent; color:#e8ecf2; cursor:pointer; font:inherit;';
  item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,0.08)'; };
  item.onmouseleave = () => { item.style.background = 'transparent'; };
  const close = () => {
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
  };
  item.onclick = () => {
    window.dispatchEvent(new CustomEvent('o8:attach-image', { detail: { url, name } }));
    close();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const onDown = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close(); };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  menu.appendChild(item);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
}

class SpecImageWidget extends WidgetType {
  constructor(readonly images: ParsedSpecImage[], readonly repoPath: string | null) {
    super();
  }

  eq(o: SpecImageWidget): boolean {
    return this.repoPath === o.repoPath
      && this.images.length === o.images.length
      && this.images.every((im, k) => {
        const b = o.images[k];
        return !!b && im.src === b.src && im.alt === b.alt && im.width === b.width && im.height === b.height;
      });
  }

  private buildThumb(im: ParsedSpecImage): HTMLElement {
    const aspect = im.width && im.height ? im.width / im.height : 1.5;
    const w = Math.round(Math.max(60, Math.min(280, THUMB_H * aspect)));
    const url = resolveSpecImageUrl(im.src, this.repoPath);
    const box = document.createElement('div');
    box.style.cssText =
      `width:${w}px; height:${THUMB_H}px; border-radius:10px; overflow:hidden; flex-shrink:0; cursor:zoom-in;`
      + 'border:1px solid var(--o8ed-ink-faint); box-shadow:0 2px 10px rgba(0,0,0,0.12); background:rgba(127,127,127,0.08);';
    const img = document.createElement('img');
    img.src = url;
    img.alt = im.alt;
    img.loading = 'lazy';
    img.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';
    img.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openSpecLightbox(url, im.alt); };
    box.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSpecImageMenu(e.clientX, e.clientY, url, im.alt || im.src.split('/').pop() || 'image');
    };
    box.appendChild(img);
    return box;
  }

  toDOM(): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; flex-wrap:wrap; gap:8px; padding-top:6px; padding-bottom:6px; align-items:flex-start;';
    for (const im of this.images) row.appendChild(this.buildThumb(im));
    return row;
  }

  // Primes CM's pre-measure estimate (~3 thumbs/row); the real height is measured
  // post-layout. Stable because thumb box dimensions are set from WxH and never
  // change after image load, so there's no jump once measured.
  get estimatedHeight(): number {
    const rows = Math.max(1, Math.ceil(this.images.length / 3));
    return rows * (THUMB_H + 8) + 4;
  }
  ignoreEvent(): boolean { return true; }
}

function buildImageDecorations(text: string, repoPath: string | null): DecorationSet {
  const out: Range<Decoration>[] = [];
  const lines = text.split('\n');
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) { starts.push(off); off += line.length + 1; }
  let i = 0;
  while (i < lines.length) {
    const first = lines[i].length > 0 ? parsePureImageLine(lines[i]) : null;
    if (!first) { i += 1; continue; }
    // Extend over consecutive pure-image lines → one block widget rendering a
    // flex-wrap gallery row. A run of length 1 is just a single inline image.
    const imgs: ParsedSpecImage[] = [first];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j].length > 0 ? parsePureImageLine(lines[j]) : null;
      if (!next) break;
      imgs.push(next);
      j += 1;
    }
    const from = starts[i];
    const to = starts[j - 1] + lines[j - 1].length;
    out.push(Decoration.replace({ widget: new SpecImageWidget(imgs, repoPath), block: true }).range(from, to));
    i = j;
  }
  return Decoration.set(out, true);
}

export const specRepoPathFacet = Facet.define<string | null, string | null>({
  combine: (values) => (values.length ? values[values.length - 1] : null),
});
export const specRepoPathCompartment = new Compartment();

const specImageField = StateField.define<DecorationSet>({
  create: (state) => buildImageDecorations(state.doc.toString(), state.facet(specRepoPathFacet)),
  update: (deco, tr) => {
    const repoChanged = tr.startState.facet(specRepoPathFacet) !== tr.state.facet(specRepoPathFacet);
    if (tr.docChanged || repoChanged) {
      return buildImageDecorations(tr.state.doc.toString(), tr.state.facet(specRepoPathFacet));
    }
    return deco.map(tr.changes);
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Atomic so the caret skips the (hidden) image markdown instead of stepping
    // through it char by char with an invisible cursor.
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
});

/** Image-render extension. repoPath resolves repo-relative srcs; null → inert
 * for absolute/URL/data srcs only (e.g. the standalone editor lab). */
export function specImageRender(repoPath: string | null): Extension {
  return [specImageField, specRepoPathCompartment.of(specRepoPathFacet.of(repoPath))];
}
