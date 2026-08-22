import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { writeTestRunOwner } from '../test-fixture-lifecycle';

const parent = process.env.O8_TEST_FIXTURE_LEAK_PARENT?.trim();
const markerPath = process.env.O8_TEST_FIXTURE_LEAK_MARKER?.trim();

describe.skipIf(!parent || !markerPath)('fixture leak failure child', () => {
  it('fails after creating a stale fixture without teardown', () => {
    const fixturePath = mkdtempSync(path.join(parent!, 'o8-fixture-crash-'));
    writeTestRunOwner(fixturePath);
    writeFileSync(path.join(fixturePath, 'payload.bin'), Buffer.alloc(16 * 1024, 7));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(fixturePath, stale, stale);
    writeFileSync(markerPath!, fixturePath);

    expect('fixture created').toBe('teardown completed');
  });
});
