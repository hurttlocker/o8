import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SYMON_TEXT_SESSION_STALE_MS,
  appendSymonTextTranscript,
  createSymonTextSession,
  formatSymonTextPlannerPrompt,
  loadSymonTextSession,
} from './symon-text-session-store';

let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'o8-symon-text-store-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_DATA_DIR;
});

function create(now: number = 1_000) {
  return createSymonTextSession({
    subject: 'operator',
    deviceId: null,
    model: 'gpt-5.6-sol',
    effort: 'medium',
    engine: 'codex',
    workspaceMode: 'o8',
    repoId: null,
    repoPath: null,
    allowedTools: ['o8_status'],
  }, now);
}

describe('Symon text session store', () => {
  it('persists capped context and formats the next desktop-owned planner prompt', () => {
    const session = create();
    const entries = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `message-${index}`,
    }));
    const updated = appendSymonTextTranscript(session.sessionId, entries, 2_000);
    expect(updated?.transcript).toHaveLength(24);
    expect(updated?.transcript[0]?.text).toBe('message-6');
    expect(formatSymonTextPlannerPrompt(updated!, 'next question')).toContain('Symon: message-29');
    expect(formatSymonTextPlannerPrompt(updated!, 'next question')).toContain('User: next question');
  });

  it('drops a session after ten minutes without a turn', () => {
    const session = create();
    expect(loadSymonTextSession(session.sessionId, 1_000 + SYMON_TEXT_SESSION_STALE_MS)).not.toBeNull();
    expect(loadSymonTextSession(session.sessionId, 1_001 + SYMON_TEXT_SESSION_STALE_MS)).toBeNull();
  });
});
