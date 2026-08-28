'use client';

import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { CommandPaletteActionItem } from '@/components/desktop/CommandPalette';

export type CanvasCardKind = 'term' | 'file' | 'tree' | 'image' | 'video' | 'browser' | 'chat' | 'diff' | 'spec' | 'brain' | 'markdown' | 'agent';

export const CANVAS_CARD_KINDS: CanvasCardKind[] = [
  'term',
  'file',
  'tree',
  'image',
  'video',
  'browser',
  'chat',
  'diff',
  'spec',
  'brain',
  'markdown',
  'agent',
];

// Ordered most zoomed-in to most zoomed-out. The label is the operator-facing
// percentage; the value is the CSS zoom used by canvas pointer math.
export const CANVAS_ZOOM_STEPS = [
  { label: 130, value: 0.91 },
  { label: 115, value: 0.805 },
  { label: 100, value: 0.7 },
  { label: 85, value: 0.595 },
  { label: 70, value: 0.49 },
] as const;

export const CANVAS_FIT_ZOOM = CANVAS_ZOOM_STEPS.find((step) => step.label === 100)?.value ?? 0.7;

export function stepCanvasZoom(current: number, direction: 'in' | 'out'): number {
  const currentIndex = Math.max(0, CANVAS_ZOOM_STEPS.findIndex((step) => step.value === current));
  const delta = direction === 'out' ? 1 : -1;
  const nextIndex = Math.min(CANVAS_ZOOM_STEPS.length - 1, Math.max(0, currentIndex + delta));
  return CANVAS_ZOOM_STEPS[nextIndex]?.value ?? current;
}

export function useCanvasZoomHotkeys(
  setZoom: Dispatch<SetStateAction<number>>,
): void {
  useEffect(() => {
    const onZoomKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;

      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        setZoom((current) => stepCanvasZoom(current, 'in'));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((current) => stepCanvasZoom(current, 'out'));
      } else if (event.key === '0') {
        event.preventDefault();
        setZoom(CANVAS_FIT_ZOOM);
      }
    };
    window.addEventListener('keydown', onZoomKey);
    return () => window.removeEventListener('keydown', onZoomKey);
  }, [setZoom]);
}

export type CanvasCardAddressMap = Record<CanvasCardKind, ReadonlyArray<{ id: number; z: number }>>;

export function closeActiveCanvasCard(
  cards: CanvasCardAddressMap,
  closeCard: (kind: CanvasCardKind, id: number) => void,
): boolean {
  let active: { kind: CanvasCardKind; id: number; z: number } | null = null;
  for (const kind of CANVAS_CARD_KINDS) {
    for (const card of cards[kind]) {
      if (!active || card.z > active.z) active = { kind, id: card.id, z: card.z };
    }
  }
  if (!active) return false;
  closeCard(active.kind, active.id);
  return true;
}

export function selectCanvasMedia(
  kind: 'image' | 'video',
  onSelect: (file: File) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = kind === 'image' ? 'image/*' : 'video/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onSelect(file);
  }, { once: true });
  input.click();
}

export interface CanvasCommands {
  spawnTerminal: () => void;
  spawnFile: (filePath?: string) => void;
  spawnTree: () => void;
  spawnImage: () => void;
  spawnVideo: () => void;
  spawnBrowser: () => void;
  spawnChat: (threadId?: string) => void;
  spawnDiff: () => void;
  spawnSpec: () => void;
  spawnBrain: () => void;
  spawnMarkdown: () => void;
  spawnAgent: () => void;
  openSearch: () => void;
  closeActiveCard: () => void;
  zoomIn: () => void;
  zoomToFit: () => void;
  zoomOut: () => void;
}

export function canvasCommandActionItems(commands: CanvasCommands): CommandPaletteActionItem[] {
  return [
    { id: 'canvas:search', title: 'Search the canvas', detail: 'Find cards, files, repositories, and sessions', onActivate: commands.openSearch },
    { id: 'canvas:new-terminal', title: 'New terminal card', detail: 'Open a shell in the active repository', onActivate: commands.spawnTerminal },
    { id: 'canvas:new-file', title: 'New file card', detail: 'Choose a file to open on the canvas', onActivate: () => commands.spawnFile() },
    { id: 'canvas:new-tree', title: 'New file tree', detail: 'Browse the active repository on the canvas', onActivate: commands.spawnTree },
    { id: 'canvas:new-image', title: 'New image card', detail: 'Choose an image from this device', onActivate: commands.spawnImage },
    { id: 'canvas:new-video', title: 'New video card', detail: 'Choose a video from this device', onActivate: commands.spawnVideo },
    { id: 'canvas:new-browser', title: 'New browser card', detail: 'Open the dashboard in a browser card', onActivate: commands.spawnBrowser },
    { id: 'canvas:new-chat', title: 'New chat card', detail: 'Choose a recent orchestrator session', onActivate: () => commands.spawnChat() },
    { id: 'canvas:new-diff', title: 'New diff card', detail: 'Show the active repository working-tree diff', onActivate: commands.spawnDiff },
    { id: 'canvas:new-spec', title: 'New spec card', detail: 'Open the active repository o8.md', onActivate: commands.spawnSpec },
    { id: 'canvas:new-brain', title: 'New Brain card', detail: 'Ask the Engineering Brain about this repository', onActivate: commands.spawnBrain },
    { id: 'canvas:new-markdown', title: 'New markdown card', detail: 'Place a new note on the canvas', onActivate: commands.spawnMarkdown },
    { id: 'canvas:new-agent', title: 'New agent card', detail: 'Describe the work in the canvas composer', onActivate: commands.spawnAgent },
    { id: 'canvas:close-active', title: 'Close active card', detail: 'Close the frontmost canvas card', onActivate: commands.closeActiveCard },
    { id: 'canvas:zoom-in', title: 'Zoom in', detail: 'Move one step up the canvas zoom ladder', shortcut: '⌘+', onActivate: commands.zoomIn },
    { id: 'canvas:zoom-fit', title: 'Fit canvas', detail: 'Return to the tuned 100% canvas view', shortcut: '⌘0', onActivate: commands.zoomToFit },
    { id: 'canvas:zoom-out', title: 'Zoom out', detail: 'Move one step down the canvas zoom ladder', shortcut: '⌘−', onActivate: commands.zoomOut },
  ];
}
