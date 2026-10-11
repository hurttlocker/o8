import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { BundleIntegrityWarning } from './BundleIntegrityWarning';

afterEach(() => vi.unstubAllEnvs());
it.each(['production', 'test'])('keeps invalid-bundle diagnostics visible outside development (%s)', (mode) => {
  vi.stubEnv('NODE_ENV', mode);
  expect(renderToStaticMarkup(createElement(BundleIntegrityWarning, { status: { status: 'invalid', detail: 'Bundle verification failed' } }))).toContain('o8 needs to be reinstalled');
});
it('hides the presentation in hot-reload development without changing the diagnostic result', () => {
  vi.stubEnv('NODE_ENV', 'development');
  const status = { status: 'invalid' as const, detail: 'Bundle verification failed' };
  expect(renderToStaticMarkup(createElement(BundleIntegrityWarning, { status }))).toBe('');
  expect(status.status).toBe('invalid');
});
