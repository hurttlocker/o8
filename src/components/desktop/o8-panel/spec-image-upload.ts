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
import {
  buildImageMarkdown,
  createImageFileUploads,
  createImagePathUploads,
  imageFilesFromClipboard,
  imageFilesFromList,
  type PendingMarkdownImageUpload,
} from '../markdown-image-upload';

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

function handlePendingUploads(
  view: EditorView,
  pos: number,
  pending: PendingMarkdownImageUpload[],
  warning: string,
): void {
  if (pending.length === 0) return;
  // Insert all placeholders as one consecutive block, each on its own line, with
  // newline boundaries so the refs are pure-image lines (what P2's matcher and
  // gallery grouping key on) without leaving stray blank lines.
  const docLen = view.state.doc.length;
  const at = Math.max(0, Math.min(pos, docLen));
  const before = at > 0 ? view.state.doc.sliceString(at - 1, at) : '\n';
  const after = at < docLen ? view.state.doc.sliceString(at, at + 1) : '\n';
  const lead = before === '\n' ? '' : '\n';
  const trail = after === '\n' ? '' : '\n';
  const block = lead + pending.map((upload) => buildImageMarkdown(upload.placeholder)).join('\n') + trail;
  view.dispatch({ changes: { from: at, insert: block }, selection: { anchor: at + block.length } });

  for (const upload of pending) {
    const placeholder = buildImageMarkdown(upload.placeholder);
    void upload.result.then(
      (image) => swapPlaceholder(view, placeholder, buildImageMarkdown(image), false),
      (error: unknown) => {
        console.warn(warning, error);
        swapPlaceholder(view, placeholder, '', true);
      },
    );
  }
}

function handleImageFiles(view: EditorView, repoPath: string, pos: number, files: File[]): void {
  handlePendingUploads(
    view,
    pos,
    createImageFileUploads(repoPath, files),
    '[o8-spec-image] upload failed',
  );
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
export function handleImagePathsViaTauri(
  view: EditorView,
  repoPath: string,
  pos: number,
  paths: string[],
): void {
  handlePendingUploads(
    view,
    pos,
    createImagePathUploads(repoPath, paths),
    '[o8-spec-image] upload via path failed',
  );
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
