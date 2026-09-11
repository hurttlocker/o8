/**
 * "Critical" is defined in one place — enforced across the language boundary.
 *
 * Quiet mode has to hold in two runtimes. The in-app surfaces ask
 * `src/lib/presentation/quiet-mode-policy.ts`; a macOS banner is raised from
 * Rust and never passes through TypeScript at all, so `src-tauri/src/presentation.rs`
 * carries the same table. Two tables is how they drift, and a drift here means
 * something appears over a screen share that the operator was told would not.
 *
 * This test reads the Rust source and asserts the two agree: the same kinds, in
 * the same order, with the same criticality.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  QUIET_MODE_CRITICAL_NOTICE_KINDS,
  QUIET_MODE_NOTICE_KINDS,
  quietModeSuppresses,
  noticeIsVisible,
} from '@/lib/presentation/quiet-mode-policy';

const RUST_SOURCE = path.join(process.cwd(), 'src-tauri', 'src', 'presentation.rs');

/** Wire names in `NoticeKind::as_str`, in declaration order. */
function rustNoticeKinds(source: string): string[] {
  const body = source.slice(source.indexOf('fn as_str('), source.indexOf('// ── Overlay bookkeeping'));
  return [...body.matchAll(/NoticeKind::\w+\s*=>\s*"([a-z-]+)"/g)].map((match) => match[1]);
}

/** The variants `quiet_mode_suppresses` exempts. */
function rustCriticalKinds(source: string, allKinds: string[]): string[] {
  const start = source.indexOf('pub fn quiet_mode_suppresses(');
  const body = source.slice(start, source.indexOf('}', start));
  const variants = [...body.matchAll(/NoticeKind::(\w+)/g)].map((match) => match[1]);
  const wireByVariant = new Map<string, string>();
  for (const [, variant, wire] of source.matchAll(/NoticeKind::(\w+)\s*=>\s*"([a-z-]+)"/g)) {
    wireByVariant.set(variant, wire);
  }
  const critical = variants.map((variant) => wireByVariant.get(variant)).filter((wire): wire is string => Boolean(wire));
  // Order by the shared declaration order so the comparison is stable.
  return allKinds.filter((kind) => critical.includes(kind));
}

describe('quiet-mode notice policy parity', () => {
  const source = readFileSync(RUST_SOURCE, 'utf8');

  it('declares the same notice kinds on both sides', () => {
    const rustKinds = rustNoticeKinds(source);
    expect(rustKinds.length).toBeGreaterThan(0);
    expect(rustKinds).toEqual([...QUIET_MODE_NOTICE_KINDS]);
  });

  it('classifies the same kinds as critical on both sides', () => {
    const rustCritical = rustCriticalKinds(source, [...QUIET_MODE_NOTICE_KINDS]);
    expect(rustCritical.length).toBeGreaterThan(0);
    expect(rustCritical).toEqual([...QUIET_MODE_CRITICAL_NOTICE_KINDS]);
  });

  it('keeps approvals and errors visible and hides the convenience surfaces', () => {
    for (const kind of QUIET_MODE_CRITICAL_NOTICE_KINDS) {
      expect(quietModeSuppresses(kind)).toBe(false);
      expect(noticeIsVisible(kind, true)).toBe(true);
    }
    for (const kind of QUIET_MODE_NOTICE_KINDS) {
      if (QUIET_MODE_CRITICAL_NOTICE_KINDS.includes(kind)) continue;
      expect(quietModeSuppresses(kind)).toBe(true);
      expect(noticeIsVisible(kind, true)).toBe(false);
      // Nothing is hidden while quiet mode is off.
      expect(noticeIsVisible(kind, false)).toBe(true);
    }
  });
});
