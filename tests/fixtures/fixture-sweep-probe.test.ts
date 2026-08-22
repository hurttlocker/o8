import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const removedPath = process.env.O8_TEST_EXPECT_REMOVED_PATH?.trim();
const detachedImage = process.env.O8_TEST_EXPECT_DETACHED_IMAGE?.trim();
const mountedPath = process.env.O8_TEST_EXPECT_MOUNTED_PATH?.trim();

describe.skipIf(!removedPath)('fixture sweep probe child', () => {
  it('observes cleanup performed before the suite starts', () => {
    expect(existsSync(removedPath!)).toBe(false);
    if (process.platform !== 'darwin' || !detachedImage || !mountedPath) return;
    const imageInfo = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
    const mounts = execFileSync('/sbin/mount', [], { encoding: 'utf8' });
    expect(imageInfo).not.toContain(detachedImage);
    expect(existsSync(mountedPath)).toBe(true);
    expect(mounts).toContain(mountedPath);
  });
});
