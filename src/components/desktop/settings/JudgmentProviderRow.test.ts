import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { JudgmentPath } from '@/lib/judgment/route';
import type { JudgmentProvider } from '@/lib/operator/judgment-default';
import { JudgmentProviderRow } from './JudgmentProviderRow';

function render(value: JudgmentProvider, options: { path?: JudgmentPath; managedVisible?: boolean } = {}) {
  const onChange = vi.fn();
  const markup = renderToStaticMarkup(createElement(JudgmentProviderRow, {
    icon: createElement('span'),
    value,
    path: options.path,
    managedVisible: options.managedVisible ?? false,
    busy: false,
    onChange,
  }));
  const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
  return { markup, buttons, onChange };
}

describe('JudgmentProviderRow', () => {
  it.each([
    ['off', 'off', 'Off. Advisory typed checks beside review decisions. When on, diff content leaves this machine and is sent to the provider.'],
    ['typesafe', 'key', 'Using your key. Advisory typed checks beside review decisions. When on, diff content leaves this machine and is sent to the provider.'],
  ] as const)('with the flag off and value %s it offers Off and your key only', (value, path, subtitle) => {
    const { markup, buttons, onChange } = render(value, { path });
    expect(markup).toContain('Judgment referee');
    expect(markup).toContain(subtitle);
    expect(buttons).toEqual(['Off', 'Bring your own key']);
    expect(markup).not.toContain('Managed');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers Managed only when the operator flag is on', () => {
    expect(render('off', { path: 'off' }).buttons).not.toContain('Managed');
    expect(render('off', { path: 'off', managedVisible: true }).buttons).toEqual(['Off', 'Bring your own key', 'Managed']);
  });

  it.each([
    ['plan', 'Covered by your plan'],
    ['allowance', 'Beta allowance'],
    ['key', 'Using your key'],
    ['none', 'No key or plan token found'],
  ] as const)('names the %s path and keeps the diff sentence under managed', (path, lead) => {
    const { markup } = render('managed', { path, managedVisible: true });
    expect(markup).toContain(`${lead}. Advisory typed checks beside review decisions. When on, diff content leaves this machine and is sent to the provider.`);
    expect(markup).not.toContain('not yet available');
  });

  it('says only a key is missing when typesafe has no credential', () => {
    const { markup } = render('typesafe', { path: 'none' });
    expect(markup).toContain('No key found. Advisory typed checks');
    expect(markup).not.toContain('plan token');
  });

  it('keeps a hand-written managed value selected with a note when the flag is off', () => {
    const { markup, buttons, onChange } = render('managed', { path: 'allowance' });
    expect(buttons).toEqual(['Off', 'Bring your own key', 'Managed']);
    expect(markup).toContain('Beta allowance.');
    expect(markup).toContain('Managed is not yet available on this install.');
    expect(onChange).not.toHaveBeenCalled();
  });
});
