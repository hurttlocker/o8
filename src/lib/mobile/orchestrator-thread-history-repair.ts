import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { compactTitleFromMessage } from '@/lib/llm/thread-auto-title';
import {
  isKnownComposerPreambleTitle,
  stripKnownComposerWirePreamble,
} from '@/lib/orchestrator/composer-wire';
import type { OrchestratorHistoryRecord } from './orchestrator-thread-projection';

const COMPOSER_PREAMBLE_REPAIR_MARKER = join(
  getDataDir(),
  '.composer-preamble-repaired-v1',
);

/**
 * One-time repair for history written before displayMessage reached the
 * persistence seam. Exact known o8 directives make bubble cleanup
 * unambiguous; titles are re-derived only when they retain the same marker, so
 * an operator-authored title is never guessed at or overwritten.
 */
export function repairComposerPreambleHistory(
  historyDir: string,
  persistRecord: (tabId: string, record: OrchestratorHistoryRecord, filePath: string) => void,
): void {
  try {
    if (existsSync(COMPOSER_PREAMBLE_REPAIR_MARKER)) return;
    let files: string[] = [];
    try {
      files = readdirSync(historyDir).filter((file) => file.endsWith('.json'));
    } catch {
      files = [];
    }
    let fixedThreads = 0;
    let fixedMessages = 0;
    for (const file of files) {
      const fullPath = join(historyDir, file);
      let record: OrchestratorHistoryRecord | null;
      try {
        record = JSON.parse(readFileSync(fullPath, 'utf-8')) as OrchestratorHistoryRecord;
      } catch {
        continue;
      }
      if (!record || !Array.isArray(record.messages)) continue;
      let changed = false;
      const messages = record.messages.map((message) => {
        if (message.role !== 'user' || typeof message.content !== 'string') return message;
        const content = stripKnownComposerWirePreamble(message.content);
        if (content === message.content) return message;
        changed = true;
        fixedMessages += 1;
        return { ...message, content };
      });
      if (!changed) continue;

      const nextRecord: OrchestratorHistoryRecord = { ...record, messages };
      if (record.titleSource !== 'operator' && isKnownComposerPreambleTitle(record.title)) {
        const firstUser = messages.find((message) => message.role === 'user');
        const title = compactTitleFromMessage(firstUser?.content ?? '');
        if (title) {
          nextRecord.title = title;
          nextRecord.titleSource = 'code';
          nextRecord.autoTitledAtCount = messages.length;
        }
      }
      persistRecord(basename(file, '.json'), nextRecord, fullPath);
      fixedThreads += 1;
    }
    try {
      writeFileSync(COMPOSER_PREAMBLE_REPAIR_MARKER, new Date().toISOString());
    } catch {
      // best-effort marker; the repair is idempotent if it runs again
    }
    if (fixedMessages > 0) {
      console.log(`[transcript-repair] stripped ${fixedMessages} composer preamble(s) across ${fixedThreads} thread(s)`);
    }
  } catch (error) {
    console.warn('[transcript-repair] composer preamble repair skipped:', error);
  }
}

// Marker so the one-time transcript-order repair runs once per install.
const TRANSCRIPT_REPAIR_MARKER = join(getDataDir(), '.transcript-order-repaired-v1');
// Pre-v0.1.229, ws-server froze the assistant timestamp at turn START — a
// millisecond BEFORE the user message was persisted — so timestamp-sorted
// transcripts rendered the reply above the question. The inverted pair sits
// 0-1ms apart, while a genuine reply→next-question boundary is minutes apart,
// so an adjacent [assistant→user] pair inside this window is unambiguously a
// flipped turn (the live scan found the nearest real boundary ~40min away).
const TRANSCRIPT_FLIP_GAP_MS = 5000;

/**
 * One-time, marker-gated repair of transcripts flipped by the pre-v0.1.229
 * assistant-timestamp bug. Swaps the inverted [assistant, user] pair's
 * timestamps so the question precedes the reply, then rewrites the file in
 * corrected order. Idempotent and never throws — safe to call on every boot;
 * after the marker lands it returns immediately. The persistence-layer clamp
 * in upsertMobileOrchestratorAssistantMessage prevents new flips, so this only
 * heals history written before the fix shipped.
 */
export function repairFlippedTranscriptHistory(
  historyDir: string,
  persistRecord: (tabId: string, record: OrchestratorHistoryRecord) => void,
): void {
  try {
    if (existsSync(TRANSCRIPT_REPAIR_MARKER)) return;
    let files: string[] = [];
    try {
      files = readdirSync(historyDir).filter((file) => file.endsWith('.json'));
    } catch {
      files = [];
    }
    let fixedThreads = 0;
    let fixedPairs = 0;
    for (const file of files) {
      const fullPath = join(historyDir, file);
      let record: OrchestratorHistoryRecord | null;
      try {
        record = JSON.parse(readFileSync(fullPath, 'utf-8')) as OrchestratorHistoryRecord;
      } catch {
        continue;
      }
      if (!record || !Array.isArray(record.messages)) continue;
      // Walk in render order (timestamp-sorted); the message objects are shared
      // with record.messages (shallow slice), so swapping their timestamps here
      // lands on the stored record.
      const sorted = record.messages.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      let changed = false;
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const reply = sorted[i];
        const prompt = sorted[i + 1];
        if (
          reply.role === 'assistant'
          && prompt.role === 'user'
          && typeof reply.timestamp === 'number'
          && typeof prompt.timestamp === 'number'
        ) {
          const gap = prompt.timestamp - reply.timestamp;
          if (gap >= 0 && gap < TRANSCRIPT_FLIP_GAP_MS) {
            const tmp = reply.timestamp;
            reply.timestamp = prompt.timestamp;
            prompt.timestamp = tmp;
            changed = true;
            fixedPairs += 1;
          }
        }
      }
      if (changed) {
        record.messages = record.messages
          .slice()
          .sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
        try {
          persistRecord(basename(file, '.json'), record);
          fixedThreads += 1;
        } catch {
          // best-effort per file
        }
      }
    }
    try {
      writeFileSync(TRANSCRIPT_REPAIR_MARKER, new Date().toISOString());
    } catch {
      // best-effort marker; a failed write just means we retry next boot (idempotent)
    }
    if (fixedPairs > 0) {
      console.log(`[transcript-repair] fixed ${fixedPairs} flipped turn(s) across ${fixedThreads} thread(s)`);
    }
  } catch (err) {
    console.warn('[transcript-repair] skipped:', err);
  }
}
