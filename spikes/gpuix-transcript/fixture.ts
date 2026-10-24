import type { MobileTranscriptEntry } from '../../src/lib/mobile/types';

export const TURN_COUNT = 2000;
export const TOKEN_MS = 20;
export const TOKENS = [' amber', ' garden', ' river', ' steady', ' path', ' light', ' field', ' stone'];
export const PATCH = 'diff --git a/src/sample.ts b/src/sample.ts\n--- a/src/sample.ts\n+++ b/src/sample.ts\n@@ -1,3 +1,3 @@\n export function sample() {\n-  return 1;\n+  return 2;\n }';

// One turn means one transcript entry. All identifiers and content are invented.
export const fixture: MobileTranscriptEntry[] = Array.from({ length: TURN_COUNT }, (_, i) => {
  const id = `invented-${String(i).padStart(4, '0')}`;
  if (i === TURN_COUNT - 1) return { id, role: 'assistant', text: '## Streaming result\n\nThe invented observation continues:' };
  if (i % 100 === 75) return { id, role: 'assistant', text: `### Patch ${i}\n\n\`\`\`diff\n${PATCH}\n\`\`\`` };
  if (i % 8 === 0) return { id, role: 'user', text: `Check sample ${i}: preserve the ordering and explain the result.` };
  if (i % 8 === 2 || i % 8 === 3) return { id, role: 'tool', text: '', toolCalls: [{ id: `${id}-tool`, name: 'exec_command',
    args: { command: `rg -n sample_${i} src/sample.ts` }, status: 'done', result: 'Synthetic check completed.',
    startedAt: 1700000000000 + i * 100, finishedAt: 1700000000050 + i * 100 }] };
  if (i % 16 === 5) return { id, role: 'assistant', text: `### Example ${i}\n\n\`\`\`ts\nexport function sample${i}(value: number) {\n  return value + ${i};\n}\n\`\`\`\n\nThe check preserves **ordering** and returns the expected value.` };
  return { id, role: 'assistant', text: `Sample **${i}** is ready. The invented sequence keeps each item in order.\n\n- Read the input\n- Check the boundary\n- Preserve the result\n\nThe next step uses \`sample_${i}\` without modifying other items.` };
});

export function streamedText(count: number) {
  return fixture[TURN_COUNT - 1].text + Array.from({ length: count }, (_, i) => TOKENS[i % TOKENS.length]).join('');
}
