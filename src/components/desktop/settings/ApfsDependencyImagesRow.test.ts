import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ApfsDependencyImagesRow } from './ApfsDependencyImagesRow';

describe('ApfsDependencyImagesRow', () => {
  it.each([
    { persistedValue: false, effectiveOverride: true, expected: 'true', label: 'On' },
    { persistedValue: true, effectiveOverride: false, expected: 'false', label: 'Off' },
  ])('shows and locks an environment override to $label', ({
    persistedValue,
    effectiveOverride,
    expected,
    label,
  }) => {
    const onToggle = vi.fn();
    const markup = renderToStaticMarkup(createElement(ApfsDependencyImagesRow, {
      icon: createElement('span'),
      persistedValue,
      effectiveOverride,
      busy: false,
      onToggle,
    }));

    expect(markup).toContain(`aria-checked="${expected}"`);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(`Effective policy: ${label} (overridden by environment)`);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
