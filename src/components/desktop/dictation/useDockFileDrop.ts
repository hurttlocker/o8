/**
 * useDockFileDrop — HTML5 drag-and-drop for the dock window (dossier #3).
 *
 * The Tauri DragDrop bridge is dead on transparent windows (the
 * dragDropEnabled macOS trap — contentView registration), so the dock takes
 * NATIVE DOM drops: with `.disable_drag_drop_handler()` on the window,
 * WKWebView delivers standard dragenter/dragover/drop events. Listeners sit
 * at the document level — the page wrapper is pointer-events:none, so drags
 * hit <body> and bubble here regardless of which dock mode is painted.
 *
 * WKWebView exposes file CONTENT (File API), never absolute paths, so
 * text-like files travel as bounded excerpts to `agent_files_stage`; binary
 * files stage as name+size only. The staged context rides the next ⌥-ask.
 */

import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';

export type StagedChip = { name: string; size: number };

const MAX_FILES = 5;
const PER_FILE_CAP = 48 * 1024;
const TOTAL_CAP = 160 * 1024;

/** Extensions worth reading as text (everything else stages name+size only). */
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|xml|html|css|js|jsx|ts|tsx|py|rs|go|rb|sh|zsh|swift|c|h|cpp|hpp|java|kt|sql|log|env|ini|cfg|conf|plist)$/i;

function isTextLike(file: File): boolean {
  return TEXT_EXT.test(file.name) || file.type.startsWith('text/') || file.type === 'application/json';
}

export function useDockFileDrop(onStaged: (chips: StagedChip[]) => void): boolean {
  const [dragActive, setDragActive] = useState(false);
  const depthRef = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onStagedRef = useRef(onStaged);
  useEffect(() => {
    onStagedRef.current = onStaged;
  }, [onStaged]);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const clear = () => {
      depthRef.current = 0;
      setDragActive(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };

    // WKWebView can miss the final dragleave when the cursor exits the window
    // fast — a quiet 900ms since the last dragover means the drag is gone.
    const armIdleTimer = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(clear, 900);
    };

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depthRef.current += 1;
      setDragActive(true);
      armIdleTimer();
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required, or WebKit refuses the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      armIdleTimer();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) clear();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []).slice(0, MAX_FILES);
      clear();
      if (!files.length) return;
      void stageFiles(files).then((chips) => {
        if (chips.length) onStagedRef.current(chips);
      });
    };

    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  return dragActive;
}

/** Read text excerpts (bounded) and hand the batch to Rust for the next ask. */
async function stageFiles(files: File[]): Promise<StagedChip[]> {
  let budget = TOTAL_CAP;
  const staged: { name: string; size: number; content: string | null }[] = [];
  for (const file of files) {
    let content: string | null = null;
    if (isTextLike(file) && budget > 0) {
      try {
        const text = await file.text();
        content = text.slice(0, Math.min(PER_FILE_CAP, budget));
        budget -= content.length;
      } catch {
        content = null;
      }
    }
    staged.push({ name: file.name, size: file.size, content });
  }
  if (!isTauri()) return staged.map(({ name, size }) => ({ name, size }));
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_files_stage', { files: staged });
  } catch {
    return [];
  }
  return staged.map(({ name, size }) => ({ name, size }));
}
