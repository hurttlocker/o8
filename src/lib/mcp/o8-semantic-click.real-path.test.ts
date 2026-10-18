// @ts-expect-error jsdom is a test dependency without bundled declarations
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createO8WebviewToolHandlers } from './o8-webview-tools';
import type { O8WebviewClient } from './o8-webview-client';

const dispatched: string[] = [];
let dom: JSDOM;
const client = { evalJs: async (code: string) => ({ result: dom.window.eval(code) }) } as unknown as O8WebviewClient;
const click = createO8WebviewToolHandlers(() => client).o8_view_click;

beforeEach(() => {
  dispatched.length = 0;
  dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30, toJSON: () => ({}) });
  vi.spyOn(dom.window.HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(dom.window.document.body);
});
afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

async function invoke(markup: string, locator: Record<string, unknown> = { text: 'Unavailable model' }) {
  const document = dom.window.document;
  document.body.innerHTML = markup;
  const listeners = new dom.window.AbortController();
  for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    document.body.addEventListener(type, () => dispatched.push(type), { signal: listeners.signal });
  }
  try {
    const response = await click(locator);
    const envelope = JSON.parse((response.content[0] as { text: string }).text);
    return envelope.value ?? envelope;
  } finally { listeners.abort(); }
}

describe('semantic click through the real tool handler and live DOM expression', () => {
  it.each([
    '<button disabled><span>Unavailable model</span></button>',
    '<button aria-disabled="true"><span>Unavailable model</span></button>',
    '<div inert><button><span>Unavailable model</span></button></div>',
    '<fieldset disabled><button><span>Unavailable model</span></button></fieldset>',
    '<div aria-disabled="true"><div role="option"><span>Unavailable model</span></div></div>',
    '<div role="button" disabled><span>Unavailable model</span></div>',
    '<label for="model"><span>Unavailable model</span></label><input id="model" disabled>',
  ])('refuses unavailable nested targets without pointer or mouse effects: %s', async (markup) => {
    const result = await invoke(markup);
    expect(result).toMatchObject({ clicked: false, actionDispatched: false });
    expect(['disabled', 'inert']).toContain(result.reason);
    expect(dispatched).toEqual([]);
  });

  it('refuses a role/name match inside an inert ancestor', async () => {
    const result = await invoke('<div inert><button aria-label="Unavailable model">Choose</button></div>', { role: 'button', name: 'Unavailable model' });
    expect(result).toMatchObject({ clicked: false, actionDispatched: false, reason: 'inert' });
    expect(dispatched).toEqual([]);
  });

  it('dispatches to the enabled actionable ancestor and reports input rather than a selection change', async () => {
    const result = await invoke('<button><span>Unavailable model</span></button>');
    expect(result).toMatchObject({ clicked: true, actionDispatched: true, outcome: 'input-dispatched', tag: 'BUTTON' });
    expect(dispatched).toEqual(['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('preserves the enabled first-legend exception in a disabled fieldset', async () => {
    const result = await invoke('<fieldset disabled><legend><button><span>Unavailable model</span></button></legend></fieldset>');
    expect(result).toMatchObject({ clicked: true, tag: 'BUTTON' });
  });

  it('keeps an enabled role/name target usable', async () => {
    const result = await invoke('<div role="option" aria-disabled="false">Available model</div>', { role: 'option', name: 'Available model' });
    expect(result).toMatchObject({ clicked: true, actionDispatched: true, tag: 'DIV' });
  });
});
