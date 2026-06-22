import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs sidecar, no type decls (pure logic, no side effects)
import { classifyBootProbe, BOOT_PROBE_JS } from '../scripts/preship-gate-logic.mjs';

// Encodes #1163's acceptance: a crashed / un-painted dashboard must NOT pass the
// pre-ship boot gate. The full WKWebView run lives in scripts/preship-webview-gate.mjs;
// this pins the pure verdict logic + the probe's required signals in CI.
describe('preship boot-gate classify', () => {
  it('FAILS a React mount error (route error boundary tripped)', () => {
    const v = classifyBootProbe('mount-error');
    expect(v.verdict).toBe('fail');
    expect(v.reason).toContain('mount error'); // keeps the gate's rethrow guard matching
  });

  it('FAILS the Next.js "Application error" page', () => {
    const v = classifyBootProbe('app-error');
    expect(v.verdict).toBe('fail');
    expect(v.reason).toContain('Application error');
  });

  it('PASSES only a fully hydrated + painted dashboard', () => {
    expect(classifyBootProbe('hydrated')).toEqual({ verdict: 'pass' });
  });

  it('stays PENDING (keeps polling) for an unknown / not-yet-ready result', () => {
    expect(classifyBootProbe('pending').verdict).toBe('pending');
    expect(classifyBootProbe('').verdict).toBe('pending');
    expect(classifyBootProbe('anything-else').verdict).toBe('pending');
  });

  it('requires BOTH the hydration attr AND a painted workspace box to report healthy', () => {
    // The whole point of #1163: the attribute alone is not enough — a sized
    // [data-o8-workspace] anchor must exist, so an empty render can't slip through.
    expect(BOOT_PROBE_JS).toContain('data-o8-dashboard-hydrated');
    expect(BOOT_PROBE_JS).toContain('data-o8-workspace');
    expect(BOOT_PROBE_JS).toContain('offsetHeight');
    expect(BOOT_PROBE_JS).toContain('data-o8-mount-error');
  });
});
