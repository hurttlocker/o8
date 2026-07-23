import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compactTitleFromMessage } from '@/lib/llm/thread-auto-title';
import {
  isKnownComposerPreambleTitle,
  stripKnownComposerWirePreamble,
} from '@/lib/orchestrator/composer-wire';
import type { OrchestratorHistoryRecord } from './orchestrator-thread-projection';

const COMPOSER_PREAMBLE_REPAIR_MARKER = join(
  homedir(),
  '.o8',
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
  onRecordWritten: (filePath: string) => void,
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
      writeFileSync(fullPath, JSON.stringify(nextRecord));
      onRecordWritten(fullPath);
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
