import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RuntimeBillingRow } from './RuntimeBillingRow';

it.each(['hermes', 'openclaw', 'acp'])('%s billing row explains the unavailable API mode and links the file-auth design', runtimeId => {
  const html = renderToStaticMarkup(createElement(RuntimeBillingRow, { runtimeId }));
  expect(html).toContain('is not available yet');
  expect(html).toContain('https://github.com/hurttlocker/o8/issues/4340');
  expect(html).toContain('CLI subscription');
  expect(html).not.toContain('My API key');
});
it('keeps the Codex design link separate', () => {
  const html = renderToStaticMarkup(createElement(RuntimeBillingRow, { runtimeId: 'codex' }));
  expect(html).toContain('https://github.com/hurttlocker/o8/issues/4334');
});
it('keeps the ordinary billing row for environment-capable runtimes', () => {
  const html = renderToStaticMarkup(createElement(RuntimeBillingRow, { runtimeId: 'gemini' }));
  expect(html).not.toContain('is not available yet');
  expect(html).not.toContain('/issues/4340');
});
