import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { deriveFileEdits } from '../thoughts/chat-panel/file-edits';

export interface TranscriptTurn {
  start: number;
  end: number;
  final: number | null;
  history: number[];
}

/** Presentation only: original events, permissions and errors remain intact. */
export function transcriptTurns(entries: MobileTranscriptEntry[], busy: boolean): TranscriptTurn[] {
  const starts = entries.flatMap((entry, index) => index === 0 || entry.role === 'user' ? [index] : []);
  return starts.map((start, turn) => {
    const end = starts[turn + 1] ?? entries.length;
    let answerIndex = end - 1;
    while (answerIndex > start && entries[answerIndex].role === 'system') answerIndex -= 1;
    const last = entries[answerIndex];
    const final = !(busy && end === entries.length) && last?.role === 'assistant'
      && last.text.trim() && !last.isError && !last.statusEvent && !last.collide
      && (!last.type || last.type === 'message') && !last.toolCalls?.some(call => call.status === 'running' || call.status === 'calling')
      ? answerIndex : null;
    const history: number[] = [];
    if (final !== null) for (let index = start; index < final; index += 1) {
      const entry = entries[index];
      if ((entry.role === 'assistant' || entry.role === 'tool') && !entry.isError
        && !entry.statusEvent && !entry.collide && (!entry.type || entry.type === 'message')
        && !entry.claudeCodeEvents?.some(event => event.type === 'permission_request')
        && !entry.toolCalls?.some(call => call.status === 'running' || call.status === 'calling' || call.status === 'error')) {
        history.push(index);
      }
    }
    const historySet = new Set(history);
    const lastVisible = final === null ? start : Array.from({ length: final - start }, (_, offset) => start + offset).filter(index => !historySet.has(index)).at(-1) ?? start - 1;
    return { start, end, final, history: history.filter(index => index > lastVisible) };
  });
}

export interface TurnFile { path: string; added?: number; removed?: number }

/** Use tool receipts, never all dirty files in a shared checkout. */
export function transcriptTurnFiles(entries: MobileTranscriptEntry[]): TurnFile[] {
  const files = new Map<string, TurnFile>();
  const seen = new Set<string>();
  for (const entry of entries) for (const call of entry.toolCalls ?? []) {
    if (call.status !== 'done' || (call.id && seen.has(call.id))) continue;
    if (call.id) seen.add(call.id);
    const edits = deriveFileEdits([call]);
    for (const edit of edits) {
      const previous = files.get(edit.path);
      const counted = edit.added !== undefined && (!previous || previous.added !== undefined);
      files.set(edit.path, { path: edit.path, ...(counted ? {
        added: (previous?.added ?? 0) + edit.added!, removed: (previous?.removed ?? 0) + (edit.removed ?? 0),
      } : {}) });
    }
    if (/apply_patch/i.test(call.name)) {
      const patch = call.args?.patch ?? call.args?.input;
      if (typeof patch === 'string') for (const match of patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) {
        const path = match[1].trim();
        if (path) files.set(path, { path });
      }
    }
  }
  return [...files.values()];
}
