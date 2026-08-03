import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  endToEndTaskSelection,
  readEndToEndTasks,
} from '../../scripts/bench/coding-end-to-end-tasks';

function writeTaskFixture(root: string): void {
  const fixturePath = path.join(root, 'tests/bench/coding/end-to-end-tasks.json');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, JSON.stringify({
    schema: 'o8/coding-end-to-end-tasks/v1',
    tasks: [
      { issue: 1676, label: 'one' },
      { issue: 1678, label: 'two' },
      { issue: 1679, label: 'three' },
    ],
  }));
}

describe('end-to-end task selection', () => {
  it('defaults to every task and records an explicit subset when configured', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-task-selection-'));
    try {
      writeTaskFixture(root);
      const allTasks = readEndToEndTasks(root, '');
      const subset = readEndToEndTasks(root, '1679,1676');

      expect(allTasks.map((task) => task.issue)).toEqual([1676, 1678, 1679]);
      expect(endToEndTaskSelection(allTasks)).toEqual({
        source: 'all',
        selectedIssues: [1676, 1678, 1679],
        availableIssues: [1676, 1678, 1679],
        isFullRun: true,
      });
      expect(subset.map((task) => task.issue)).toEqual([1679, 1676]);
      expect(endToEndTaskSelection(subset)).toEqual({
        source: 'subset',
        selectedIssues: [1679, 1676],
        availableIssues: [1676, 1678, 1679],
        isFullRun: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
