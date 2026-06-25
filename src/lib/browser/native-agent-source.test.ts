import { describe, it, expect } from 'vitest';
import { NATIVE_BROWSER_AGENT_SOURCE } from './native-agent-source';
import { SELECTOR_FOR_SOURCE } from './selector';
import { GRAB_PAYLOAD_SOURCE } from './grab';

describe('NATIVE_BROWSER_AGENT_SOURCE', () => {
  it('embeds the no-drift selectorFor + buildGrabbedElement sources verbatim', () => {
    // The two complex algorithms come from the shared injectable sources, not a
    // hand-copy — so they can never drift from selector.ts / grab.ts.
    expect(NATIVE_BROWSER_AGENT_SOURCE).toContain(SELECTOR_FOR_SOURCE);
    expect(NATIVE_BROWSER_AGENT_SOURCE).toContain(GRAB_PAYLOAD_SOURCE);
  });

  it('installs window.__o8BrowserAgent with the five verbs and is idempotent', () => {
    const win: Record<string, unknown> = {};
    const doc = {
      title: 'Test Page',
      body: { innerText: 'Hello World', textContent: 'Hello World', querySelectorAll: () => [] },
      querySelector: () => null,
    };
    const loc = { href: 'http://localhost:3000/dashboard' };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const run = new Function('window', 'document', 'location', NATIVE_BROWSER_AGENT_SOURCE) as (
      w: unknown,
      d: unknown,
      l: unknown,
    ) => void;

    run(win, doc, loc);
    const agent = win.__o8BrowserAgent as Record<string, unknown> | undefined;
    expect(agent).toBeTruthy();
    for (const verb of ['read', 'click', 'type', 'probe', 'grab']) {
      expect(typeof agent?.[verb]).toBe('function');
    }

    // Idempotent — a second injection must not replace the installed agent.
    const first = win.__o8BrowserAgent;
    run(win, doc, loc);
    expect(win.__o8BrowserAgent).toBe(first);
  });

  it('read() reports the real page title + url from its OWN document', () => {
    const win: Record<string, unknown> = {};
    const doc = {
      title: 'Clerk Dashboard',
      body: { innerText: 'Signed in', textContent: 'Signed in', querySelectorAll: () => [] },
      querySelector: () => null,
    };
    const loc = { href: 'http://localhost:3000/' };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const run = new Function('window', 'document', 'location', NATIVE_BROWSER_AGENT_SOURCE) as (
      w: unknown,
      d: unknown,
      l: unknown,
    ) => void;
    run(win, doc, loc);

    const agent = win.__o8BrowserAgent as { read: (a?: unknown) => Record<string, unknown> };
    const result = agent.read({});
    expect(result.ok).toBe(true);
    expect(result.title).toBe('Clerk Dashboard');
    expect(result.url).toBe('http://localhost:3000/');
    expect(result.text).toBe('Signed in');
    expect(result.interactive).toEqual([]);
  });
});
