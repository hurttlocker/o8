import type { DockEntry } from './ui';
import type { CanvasCardKind } from './canvas-commands';

const CANVAS_READ_CAP = 4096;

export interface CanvasCardLite {
  id: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  sessionName?: string | null;
  cwd?: string | null;
  name?: string;
  path?: string;
  items?: unknown[];
  tabs?: Array<{ id: number; url?: string; title?: string }>;
  activeTabId?: number;
  title?: string;
  repoPath?: string | null;
  initialQuestion?: string;
  codename?: string;
  number?: number;
  aspect?: number;
  markdown?: string;
  diff?: string;
  truncated?: boolean;
  threadId?: string;
  entries?: DockEntry[];
  laneId?: string;
  runtime?: string | null;
  src?: string;
  mediaId?: string;
  poster?: string;
  branch?: string | null;
  stat?: string;
  packetId?: string | null;
}

export function canvasCardTitle(kind: CanvasCardKind, card: CanvasCardLite): string {
  switch (kind) {
    case 'term': return card.sessionName || (card.cwd ? `terminal · ${card.cwd}` : 'terminal');
    case 'file': return card.name || card.path || 'file';
    case 'tree': return card.repoPath ? `files · ${card.repoPath.split('/').filter(Boolean).pop()}` : 'file tree';
    case 'image': return `${card.items?.length ?? 1} image${(card.items?.length ?? 1) === 1 ? '' : 's'}`;
    case 'video': return card.name || 'video';
    case 'browser': {
      const active = card.tabs?.find((tab) => tab.id === card.activeTabId) ?? card.tabs?.[0];
      return active?.title || active?.url || 'browser';
    }
    case 'chat': return card.title || 'session';
    case 'diff': return card.title || 'diff';
    case 'spec': return card.repoPath ? `spec · ${card.repoPath.split('/').pop()}` : 'o8.md';
    case 'brain': return card.initialQuestion || 'brain';
    case 'markdown': return card.title || 'note';
    case 'agent': return card.codename || card.title || `agent #${card.number ?? '?'}`;
    default: return kind;
  }
}

export function capCanvasReadContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= CANVAS_READ_CAP) return { content, truncated: false };
  const head = content.slice(0, Math.floor(CANVAS_READ_CAP / 2));
  const tail = content.slice(content.length - Math.ceil(CANVAS_READ_CAP / 2));
  return { content: `${head}\n...\n${tail}`.slice(0, CANVAS_READ_CAP), truncated: true };
}

export function dockEntryReadLine(entry: DockEntry): string {
  if (entry.role === 'user') return `user: ${entry.text}`;
  if (entry.role === 'text') return `assistant: ${entry.text}`;
  if (entry.role === 'thinking') return `thinking: ${entry.text}`;
  if (entry.role === 'status') return `status: ${entry.text}`;
  if (entry.role === 'playback') return `playback: ${entry.text}`;
  if (entry.role === 'result') return `result: ${entry.title}${entry.body ? `\n${entry.body}` : ''}`;
  return '';
}
