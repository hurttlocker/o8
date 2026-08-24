import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { describe, it } from 'vitest';

const rootMarker = process.env.O8_TEST_TIMEOUT_ROOT_MARKER?.trim();
const childMarker = process.env.O8_TEST_TIMEOUT_CHILD_MARKER?.trim();

describe.skipIf(!rootMarker || !childMarker)('fixture timeout retention child', () => {
  it('keeps working after the harness records the timeout', async () => {
    const runRoot = process.env.O8_TEST_RUN_DATA_ROOT!;
    const workerRoot = process.env.CORTEX_IDE_DATA_DIR!;
    writeFileSync(rootMarker!, JSON.stringify({ runRoot, workerRoot }));
    const script = `
      const { writeFileSync } = require('node:fs');
      setTimeout(() => {
        try {
          process.cwd();
          writeFileSync(${JSON.stringify(childMarker)}, 'cwd-ok');
        } catch (error) {
          writeFileSync(${JSON.stringify(childMarker)}, 'cwd-missing:' + (error.code || error.message));
        }
      }, 200);
    `;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: workerRoot,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Vitest rejects this test at 50 ms but does not cancel this promise or
    // the detached child. The harness must not delete their cwd underneath it.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }, 50);
});
