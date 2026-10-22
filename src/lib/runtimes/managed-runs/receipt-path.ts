import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Resolve missing tails too, but never treat a dangling symlink as a missing path. */
function canonicalPath(value: string): string | null {
  let current = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...missing); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      try { lstatSync(current); return null; } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

/** Only the legacy data location and the owned launcher's temporary layout are receipts. */
export function resolveManagedRunExitReceipt(id: string, supplied?: unknown): string | null {
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  const legacy = join(getDataDir(), 'logs', 'run', `${id}.exit`);
  const candidate = supplied === undefined ? legacy : supplied;
  if (typeof candidate !== 'string' || candidate.length > 4096 || !isAbsolute(candidate)) return null;
  const canonicalData = canonicalPath(getDataDir());
  const canonicalTemp = canonicalPath(tmpdir());
  if (!canonicalData || !canonicalTemp) return null;
  let base: string;
  let tail: string[];
  if (candidate === legacy || candidate === join(canonicalData, 'logs', 'run', `${id}.exit`)) {
    base = canonicalData;
    tail = ['logs', 'run', `${id}.exit`];
  } else {
    const root = candidate.startsWith(`${tmpdir()}${sep}`) ? tmpdir() : canonicalTemp;
    base = canonicalTemp;
    tail = relative(root, candidate).split(sep);
    if (tail.length !== 5 || tail[0] !== 'o8-worker-runs'
      || !/^\d{10,17}-[a-f0-9]{8}$/.test(tail[1])
      || tail[2] !== 'logs' || tail[3] !== 'run' || tail[4] !== `${id}.exit`
      || candidate !== join(root, ...tail)) return null;
  }
  const expected = join(base, ...tail);
  // Reject symlinks below the trusted root, including a replaced receipt file.
  if (canonicalPath(candidate) !== expected) return null;
  try {
    const file = lstatSync(expected);
    if (!file.isFile() || file.nlink !== 1 || file.size > 64) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  return expected;
}
