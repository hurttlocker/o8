/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginsPreviewTab from './PluginsPreviewTab';
import { CustomizeHeader } from './CustomizeHeader';

describe('development plugin preview', () => {
  let host: HTMLDivElement;
  let root: Root;
  const requests = vi.fn();
  const click = (text: string) => {
    const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
    expect(button, `Missing button: ${text}`).toBeDefined();
    act(() => button?.click());
  };
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    requests.mockReset();
    vi.stubGlobal('fetch', requests);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps the configured version when an update fails without calling a backend', () => {
    act(() => root.render(createElement(PluginsPreviewTab)));
    click('Project guide');
    click('Finish setup');
    click('Use demo connection');
    expect(host.textContent).toContain('Ready');
    click('Update to 1.1');
    click('Simulate failed update');
    expect(host.textContent).toContain('Version 1.0 remains available');
    expect(host.textContent).toContain('Ready');
    click('Retry update');
    click('Apply demo update');
    expect(host.textContent).toContain('v1.1');
    expect(host.textContent).not.toContain('Update could not be activated');
    expect(requests).not.toHaveBeenCalled();
  });

  it('clears the disabled notice when the sample is enabled again', () => {
    act(() => root.render(createElement(PluginsPreviewTab)));
    click('Project guide');
    click('Disable sample');
    expect(host.textContent).toContain('Sample contributions are disabled');
    click('Enable sample');
    expect(host.textContent).not.toContain('Sample contributions are disabled');
    expect(host.textContent).toContain('One setup step remaining');
  });

  it('retains optional sample setup on removal and resets the preview on demand', () => {
    act(() => root.render(createElement(PluginsPreviewTab)));
    click('Project guide');
    click('Finish setup');
    click('Use demo connection');
    click('Remove sample');
    click('Confirm removal');
    expect(host.textContent).toContain('No sample plugins installed');
    click('Browse');
    click('Project guide');
    click('Review installation');
    click('Add to preview');
    expect(host.textContent).toContain('Ready');
    click('Reset preview');
    click('Project guide');
    expect(host.textContent).toContain('v1.0');
    expect(host.textContent).toContain('One setup step remaining');
    expect(requests).not.toHaveBeenCalled();
  });

  it('does not carry setup through removal when the user clears it', () => {
    act(() => root.render(createElement(PluginsPreviewTab)));
    click('Project guide');
    click('Finish setup');
    click('Use demo connection');
    click('Remove sample');
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    click('Confirm removal');
    click('Browse');
    click('Project guide');
    click('Review installation');
    click('Add to preview');
    expect(host.textContent).toContain('One setup step remaining');
    expect(requests).not.toHaveBeenCalled();
  });

  it('offers the preview only in development while retaining all real sections', () => {
    const props = { tab: 'rules' as const, onTab: vi.fn(), query: '', onQuery: vi.fn(), repos: [], scope: 'all', onScope: vi.fn(), counts: {} };
    vi.stubEnv('NODE_ENV', 'production');
    act(() => root.render(createElement(CustomizeHeader, props)));
    expect(host.textContent).not.toContain('Plugins');
    for (const label of ['Instructions', 'Commands', 'Prompts', 'Skills', 'Connections', 'Agents', 'Hooks']) expect(host.textContent).toContain(label);
    vi.stubEnv('NODE_ENV', 'development');
    act(() => root.render(createElement(CustomizeHeader, props)));
    expect(host.textContent).toContain('Plugins');
    click('Plugins');
    expect(props.onTab).toHaveBeenCalledWith('plugins');
  });
});
