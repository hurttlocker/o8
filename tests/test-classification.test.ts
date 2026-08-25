import { describe, expect, it } from 'vitest';
import { classifyTestSource } from '../scripts/lib/test-classification.mjs';

describe('test factory classification', () => {
  it('routes real Git, process, APFS, and listener ownership to integration', () => {
    expect(classifyTestSource('tests/lane-real-path.test.ts', 'describe("plain", () => {})'))
      .toContain('real-path');
    expect(classifyTestSource('tests/plain.test.ts', "import { spawn } from 'node:child_process'"))
      .toContain('child-process');
    expect(classifyTestSource('tests/plain.test.ts', "execFileSync('git', ['init'])"))
      .toEqual(expect.arrayContaining(['child-process', 'git-cli']));
    expect(classifyTestSource('tests/plain.test.ts', 'const server = createServer(handler)'))
      .toContain('network-listener');
  });

  it('leaves a pure in-memory assertion in the hermetic unit lane', () => {
    expect(classifyTestSource('src/lib/math.test.ts', 'expect(1 + 1).toBe(2)')).toEqual([]);
  });
});
