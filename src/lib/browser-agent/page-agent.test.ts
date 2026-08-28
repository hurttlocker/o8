// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBrowserAgent } from './page-agent';

afterEach(() => {
  delete window.__o8BrowserAgent;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('page-agent grab', () => {
  it('returns the compact DOM and accessibility summary through the installed grab verb', () => {
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const frame = document.createElement('iframe');
    frame.dataset.o8Browser = 'panel';
    frame.dataset.o8Active = 'true';
    document.body.appendChild(frame);

    const page = frame.contentDocument;
    if (!page) throw new Error('iframe document was not created');
    page.body.innerHTML = [
      '<main id="workspace" class="shell root">',
      '  <section class="settings area">',
      '    <div class="controls row">',
      '      <button id="save" class="primary wide" aria-label="Save changes">Save</button>',
      '    </div>',
      '  </section>',
      '</main>',
    ].join('');
    const button = page.querySelector('#save');
    if (!button) throw new Error('fixture button was not created');
    button.getBoundingClientRect = () => ({
      top: 24,
      left: 48,
      width: 120,
      height: 36,
      right: 168,
      bottom: 60,
      x: 48,
      y: 24,
      toJSON: () => ({}),
    });

    installBrowserAgent();
    const result = window.__o8BrowserAgent?.grab({ surface: 'panel', selector: '#save' });
    if (!result?.ok) throw new Error(result?.error ?? 'grab failed');

    expect(result.element.domSummary).toEqual({
      role: 'button',
      accessibleName: 'Save changes',
      ancestorChain: ['body', 'main#workspace.shell.root', 'section.settings.area', 'div.controls.row'],
      boundingRect: { top: 24, left: 48, width: 120, height: 36 },
      nearestLandmark: 'main#workspace.shell.root',
    });
  });
});
