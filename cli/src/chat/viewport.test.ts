import { describe, expect, it } from 'vitest';
import { transcriptLines, transcriptWindow } from './view.js';

const messages = [
  { id: 'u1', role: 'user' as const, text: 'First task', tools: [] },
  { id: 'a1', role: 'assistant' as const, text: Array.from({ length: 30 }, (_, i) => `Earlier ${i}`).join('\n'), tools: [] },
  { id: 'u2', role: 'user' as const, text: 'Latest task', tools: [] },
  { id: 'a2', role: 'assistant' as const, text: Array.from({ length: 30 }, (_, i) => `Latest ${i}`).join('\n'), tools: [] },
];

describe('terminal transcript reading position', () => {
  it('pins the prompt for the answer being read and yields when the prompt is visible', () => {
    const lines = transcriptLines(messages, 60, false);
    expect(transcriptWindow(lines, 10, null).prompt).toBe('Latest task');
    expect(transcriptWindow(lines, 10, 8).prompt).toBe('First task');
    expect(transcriptWindow(lines, 10, 0).prompt).toBeUndefined();
    expect(transcriptWindow(lines, 10, 0).lines[0]?.text).toContain('You');
  });

  it('holds the same rows while streaming grows and follows only on return to latest', () => {
    const lines = transcriptLines(messages, 60, false);
    const before = transcriptWindow(lines, 10, 8);
    const more = [...lines, ...Array.from({ length: 20 }, (_, i) => ({ text: `New ${i}` }))];
    expect(transcriptWindow(more, 10, 8).lines).toEqual(before.lines);
    expect(transcriptWindow(more, 10, null).lines.at(-1)?.text).toBe('New 19');
  });
});
