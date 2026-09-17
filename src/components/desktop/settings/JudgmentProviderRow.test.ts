import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JudgmentProviderRow } from './JudgmentProviderRow';

describe('JudgmentProviderRow', () => {
  it.each(['off', 'typesafe'] as const)('states that diff content leaves the machine when set to %s', (value) => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(createElement(JudgmentProviderRow, {
      icon: createElement('span'),
      value,
      busy: false,
      onChange,
    }));

    expect(markup).toContain('Judgment referee');
    expect(markup).toContain('When on, diff content leaves this machine and is sent to the provider');
    expect(markup).toContain('TypeSafe');
    expect(onChange).not.toHaveBeenCalled();
  });
});
