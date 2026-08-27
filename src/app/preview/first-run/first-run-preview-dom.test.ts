// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunPreview } from './FirstRunPreview';

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  roots.splice(0).forEach((root) => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle(milliseconds = 80) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

describe('first-run preview route surface', () => {
  it('renders the real consent card and drives its saving state from the harness', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => { root.render(createElement(FirstRunPreview)); });
    await settle();
    expect(document.querySelector('[aria-labelledby="telemetry-consent-title"]')).not.toBeNull();

    const statePicker = document.querySelector('[aria-label="Consent state"]') as HTMLSelectElement;
    statePicker.value = 'saving';
    await act(async () => { statePicker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(160);

    expect(document.body.textContent).toContain('Saving choices…');
    expect(document.body.textContent).toContain('isolated state');
  });

  it('jumps through the real onboarding flow without a live API', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => { root.render(createElement(FirstRunPreview)); });
    await settle();

    const surfacePicker = document.querySelector('[aria-label="First-run surface"]') as HTMLSelectElement;
    surfacePicker.value = 'onboarding';
    await act(async () => { surfacePicker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(document.body.textContent).toContain('Run an AI engineering');

    const stepPicker = document.querySelector('[aria-label="Onboarding step"]') as HTMLSelectElement;
    stepPicker.value = 'ready';
    await act(async () => { stepPicker.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(document.body.textContent).toContain('Ready to go');
  });
});
