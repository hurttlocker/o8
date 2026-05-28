/*
 * spec-image-upload — inline image authoring for the o8.md editor (P1).
 *
 * A CodeMirror domEventHandlers extension that intercepts image PASTE / DROP
 * scoped to the editor, uploads the bytes to <repo>/o8-assets/ via the new
 * /api/repo-spec/asset writer, and splices a ref — ![alt](o8-assets/… "WxH") —
 * at the cursor. The width×height (measured client-side at upload) is parked in
 * the markdown title so P2's render widget can reserve a FIXED height before the
 * image loads (the margin-note rail assumes stable line heights).
 *
 * Scoped to the editor (not window-level) AND stopPropagation on handled events
 * so it never collides with the chat composer's window-level paste listener.
 * Markdown stays a tiny ref — never base64 — so the o8.md 256KB cap is safe.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i;

function isUploadableImage(file: File): boolean {
  return IMAGE_MIME.test(file.type);
}

function imageFilesFromList(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter(isUploadableImage);
}

// Paste exposes the image on clipboardData.files in modern Chromium, but fall
// back to the items[] API for robustness.
function imageFilesFromClipboard(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const fromFiles = imageFilesFromList(dt.files);
  if (fromFiles.length > 0) return fromFiles;
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f && isUploadableImage(f)) out.push(f);
    }
  }
  return out;
}

interface ImageSize {
  width: number;
  height: number;
}

// createImageBitmap is the cheapest path (no DOM, no leak) and works in the
// Tauri webview. SVGs often report 0×0 — fall back to <img>, then give up (the
// render widget falls back to a default aspect when WxH is absent).
async function readImageSize(file: File): Promise<ImageSize | null> {
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    if (size.width > 0 && size.height > 0) return size;
  } catch {
    /* fall through */
  }
  try {
    const url = URL.createObjectURL(file);
    const size = await new Promise<ImageSize | null>((res) => {
      const img = new Image();
      img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => res(null);
      img.src = url;
    });
    URL.revokeObjectURL(url);
    if (size && size.width > 0 && size.height > 0) return size;
  } catch {
    /* ignore */
  }
  return null;
}

async function uploadSpecImage(repoPath: string, file: File): Promise<string> {
  const res = await fetch(`/api/repo-spec/asset?repoPath=${encodeURIComponent(repoPath)}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'x-filename': encodeURIComponent(file.name || 'image'),
    },
    body: file,
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; relPath?: unknown; error?: unknown } | null;
  if (!res.ok || !data?.ok || typeof data.relPath !== 'string') {
    throw new Error(typeof data?.error === 'string' ? data.error : `upload failed (${res.status})`);
  }
  return data.relPath;
}

function altFromName(name: string): string {
  return (name.replace(/\.[^.]+$/, '') || 'image').replace(/[\]\r\n"]/g, '').trim().slice(0, 80) || 'image';
}

function buildImageMarkdown(relPath: string, alt: string, size: ImageSize | null): string {
  const title = size ? ` "${size.width}x${size.height}"` : '';
  return `![${alt}](${relPath}${title})`;
}

let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}${nonceCounter.toString(36)}`;
}

interface PendingInsert {
  file: File;
  placeholder: string;
}

// Replace the exact placeholder string wherever it currently sits — robust to
// the operator editing elsewhere while an upload is in flight (positions move,
// the string doesn't). If they deleted the placeholder, the swap is a no-op.
function swapPlaceholder(view: EditorView, placeholder: string, replacement: string, dropLine: boolean): void {
  const doc = view.state.doc.toString();
  const idx = doc.indexOf(placeholder);
  if (idx < 0) return;
  let to = idx + placeholder.length;
  if (dropLine && doc[to] === '\n') to += 1; // remove the now-empty line on failure
  view.dispatch({ changes: { from: idx, to, insert: replacement } });
}

function handleImageFiles(view: EditorView, repoPath: string, pos: number, files: File[]): void {
  const pending: PendingInsert[] = files.map((file) => {
    const safeName = (file.name || 'image').replace(/[\]\r\n]/g, '').slice(0, 60);
    return { file, placeholder: `![Uploading ${safeName}…](#o8-upload-${nextNonce()})` };
  });

  // Insert all placeholders as one consecutive block, each on its own line, with
  // newline boundaries so the refs are pure-image lines (what P2's matcher and
  // gallery grouping key on) without leaving stray blank lines.
  const docLen = view.state.doc.length;
  const at = Math.max(0, Math.min(pos, docLen));
  const before = at > 0 ? view.state.doc.sliceString(at - 1, at) : '\n';
  const after = at < docLen ? view.state.doc.sliceString(at, at + 1) : '\n';
  const lead = before === '\n' ? '' : '\n';
  const trail = after === '\n' ? '' : '\n';
  const block = lead + pending.map((p) => p.placeholder).join('\n') + trail;
  view.dispatch({ changes: { from: at, insert: block }, selection: { anchor: at + block.length } });

  for (const p of pending) {
    void (async () => {
      try {
        const [relPath, size] = await Promise.all([uploadSpecImage(repoPath, p.file), readImageSize(p.file)]);
        swapPlaceholder(view, p.placeholder, buildImageMarkdown(relPath, altFromName(p.file.name), size), false);
      } catch (err) {
        console.warn('[o8-spec-image] upload failed', err);
        swapPlaceholder(view, p.placeholder, '', true);
      }
    })();
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/* Tauri drag-drop bridge                                                 */
/* ────────────────────────────────────────────────────────────────────── */

/**
 * When `dragDropEnabled: true` is set in tauri.conf.json (it is — needed for
 * the terminal / canvas / Monaco drop epics), the OS-level Finder→app file
 * drop is INTERCEPTED by Tauri before it ever hits the HTML5 `drop` event.
 * So the CodeMirror extension below stops seeing real file drops in the prod
 * app. The Rust side bridges those drops into a `o8:tauri-file-drop` event
 * (paths + position) via the `useTauriFileDrop` hook; this function is the
 * upload counterpart that takes those absolute paths and inserts the same
 * `![alt](o8-assets/...)` refs the body-bytes path produces.
 */
const TAURI_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

async function uploadSpecImageByPath(repoPath: string, srcPath: string): Promise<string> {
  const url = `/api/repo-spec/asset?repoPath=${encodeURIComponent(repoPath)}&srcPath=${encodeURIComponent(srcPath)}`;
  const res = await fetch(url, { method: 'POST' });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; relPath?: unknown; error?: unknown } | null;
  if (!res.ok || !data?.ok || typeof data.relPath !== 'string') {
    throw new Error(typeof data?.error === 'string' ? data.error : `upload failed (${res.status})`);
  }
  return data.relPath;
}

export function handleImagePathsViaTauri(
  view: EditorView,
  repoPath: string,
  pos: number,
  paths: string[],
): void {
  const imagePaths = paths.filter((p) => {
    const dot = p.lastIndexOf('.');
    return dot >= 0 && TAURI_IMAGE_EXTS.has(p.slice(dot).toLowerCase());
  });
  if (imagePaths.length === 0) return;

  const pending = imagePaths.map((srcPath) => {
    const baseName = (srcPath.split('/').pop() || 'image').replace(/[\]\r\n]/g, '').slice(0, 60);
    return { srcPath, baseName, placeholder: `![Uploading ${baseName}…](#o8-upload-${nextNonce()})` };
  });

  const docLen = view.state.doc.length;
  const at = Math.max(0, Math.min(pos, docLen));
  const before = at > 0 ? view.state.doc.sliceString(at - 1, at) : '\n';
  const after = at < docLen ? view.state.doc.sliceString(at, at + 1) : '\n';
  const lead = before === '\n' ? '' : '\n';
  const trail = after === '\n' ? '' : '\n';
  const block = lead + pending.map((p) => p.placeholder).join('\n') + trail;
  view.dispatch({ changes: { from: at, insert: block }, selection: { anchor: at + block.length } });

  for (const p of pending) {
    void (async () => {
      try {
        const relPath = await uploadSpecImageByPath(repoPath, p.srcPath);
        swapPlaceholder(view, p.placeholder, buildImageMarkdown(relPath, altFromName(p.baseName), null), false);
      } catch (err) {
        console.warn('[o8-spec-image] upload via path failed', err);
        swapPlaceholder(view, p.placeholder, '', true);
      }
    })();
  }
}

/**
 * Editor extension enabling image paste/drop → upload → inline ref. When
 * getRepoPath() returns null (e.g. the standalone editor lab) it stays inert and
 * the editor behaves as a pure markdown surface.
 */
export function specImageDropPaste(getRepoPath: () => string | null): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const repoPath = getRepoPath();
      if (!repoPath) return false;
      const files = imageFilesFromClipboard(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      event.stopPropagation(); // keep the chat composer's window paste from also grabbing it
      handleImageFiles(view, repoPath, view.state.selection.main.head, files);
      return true;
    },
    dragover(event) {
      // Mark the editor as a valid drop target for file drags so `drop` fires.
      if (getRepoPath() && Array.from(event.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) {
        event.preventDefault();
      }
      return false;
    },
    drop(event, view) {
      const repoPath = getRepoPath();
      if (!repoPath) return false;
      const files = imageFilesFromList(event.dataTransfer?.files);
      if (files.length === 0) return false;
      event.preventDefault();
      event.stopPropagation();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      handleImageFiles(view, repoPath, pos, files);
      return true;
    },
  });
}
