import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The parent checks this receipt against its independently owned temporary root.
describe('data handoff probe', () => {
  it('runs inside a real temporary worker data root', () => {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR;
    expect(dataDir).toBeTruthy();
    expect(path.basename(dataDir!)).toMatch(/^vitest-worker-/);
    const marker = process.env.O8_DATA_HANDOFF_PROBE_MARKER;
    if (marker) writeFileSync(marker, `ran:${dataDir}\n`);
  });
});
