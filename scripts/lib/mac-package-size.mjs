import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FOOTPRINT_BUDGET, measureDiskBytes } from './footprint-budget.mjs';
import { assertTauriExportInputsSafe } from './tauri-export-safety.mjs';

// Use the native acceptance ceilings and measurement, not a second budget.
// With no archive argument, measure a fresh throwaway tarball so an old
// updater cannot make an oversized current app appear safe to notarize.
export function assertMacPackageSize(appPath, archivePath, { releaseVersion } = {}) {
  if (!lstatSync(appPath).isDirectory()) throw new Error('app bundle must be a directory, not a link');
  assertTauriExportInputsSafe(join(appPath, 'Contents', 'Resources', 'server'));
  // One approved release allowance while export/dependency reduction continues
  // in #3545. All other versions retain the shared 300/80 MiB ceiling. This
  // deliberately rejects the unpruned 365/92 MiB candidate as well.
  const allowance = releaseVersion === '0.1.789' ? 'release-0.1.789' : null;
  const ceilings = allowance
    ? { appBundleBytes: 312 * 1024 * 1024, updaterArchiveBytes: 88 * 1024 * 1024 }
    : FOOTPRINT_BUDGET.regressionCeilings;
  const appBundleBytes = measureDiskBytes(appPath);
  if (appBundleBytes > ceilings.appBundleBytes) {
    throw new Error(`appBundleBytes ${appBundleBytes} exceeds ${ceilings.appBundleBytes}; refusing oversized package`);
  }
  let scratch;
  try {
    if (!archivePath) {
      scratch = mkdtempSync(join(tmpdir(), 'o8-package-size-'));
      archivePath = join(scratch, 'app.tar.gz');
      execFileSync('tar', ['czf', archivePath, '-C', dirname(appPath), basename(appPath)], {
        stdio: 'pipe', timeout: 120_000,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
    }
    const updaterArchiveBytes = statSync(archivePath).size;
    if (updaterArchiveBytes > ceilings.updaterArchiveBytes) {
      throw new Error(`updaterArchiveBytes ${updaterArchiveBytes} exceeds ${ceilings.updaterArchiveBytes}; refusing oversized package`);
    }
    return { appBundleBytes, updaterArchiveBytes, allowance };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
