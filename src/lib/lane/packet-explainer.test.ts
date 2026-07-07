import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// store.ts (imported transitively) resolves the data dir at load — set first.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-explainer-'));

const { parseExplainerQuiz } = await import('./packet-explainer');
const { artifactExtForMime } = await import('@/lib/artifacts/store');

const quizJson = JSON.stringify({
  questions: [
    { id: 'q1', prompt: 'What changed?', options: ['A', 'B'], answerIndex: 0 },
    { id: 'q2', prompt: 'Risk?', options: ['Low', 'High', 'None'], answerIndex: 1 },
    { id: 'q3', prompt: 'Files?', options: ['1', '2'], answerIndex: 1 },
  ],
});

describe('parseExplainerQuiz', () => {
  it('extracts a valid quiz from the embedded script block', () => {
    const html = `<html><body><h1>x</h1><script type="application/json" id="o8-quiz">${quizJson}</script></body></html>`;
    const quiz = parseExplainerQuiz(html);
    expect(quiz?.questions).toHaveLength(3);
    expect(quiz?.questions[1]).toMatchObject({ id: 'q2', answerIndex: 1 });
  });

  it('returns null when the block is absent or malformed', () => {
    expect(parseExplainerQuiz('<html></html>')).toBeNull();
    expect(parseExplainerQuiz('<script type="application/json" id="o8-quiz">not json</script>')).toBeNull();
  });

  it('rejects a too-short quiz (fewer than 3 questions)', () => {
    const short = JSON.stringify({ questions: [{ id: 'q1', prompt: 'x', options: ['a', 'b'], answerIndex: 0 }] });
    expect(parseExplainerQuiz(`<script type="application/json" id="o8-quiz">${short}</script>`)).toBeNull();
  });

  it('drops malformed questions and requires a valid answerIndex', () => {
    const mixed = JSON.stringify({
      questions: [
        { id: 'q1', prompt: 'ok', options: ['a', 'b'], answerIndex: 0 },
        { id: 'q2', prompt: 'bad', options: ['only one'], answerIndex: 0 },
        { id: 'q3', prompt: 'oob', options: ['a', 'b'], answerIndex: 9 },
        { id: 'q4', prompt: 'ok2', options: ['a', 'b', 'c'], answerIndex: 2 },
      ],
    });
    // Only 2 of 4 survive → below the 3-question floor → null.
    expect(parseExplainerQuiz(`<script type="application/json" id="o8-quiz">${mixed}</script>`)).toBeNull();
  });
});

describe('artifactExtForMime', () => {
  it('maps report HTML to an .html extension', () => {
    expect(artifactExtForMime('text/html')).toBe('html');
  });
  it('falls back to png for unknown types', () => {
    expect(artifactExtForMime('application/octet-stream')).toBe('png');
  });
});
