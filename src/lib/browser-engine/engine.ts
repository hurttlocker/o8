import 'server-only';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { SELECTOR_FOR_SOURCE } from '@/lib/browser/selector';
import { GRAB_PAYLOAD_SOURCE, type GrabbedElement } from '@/lib/browser/grab';

/**
 * Browser engine (#1232 phase 3) — a REAL browser for agents, driving the
 * user's installed Chrome via playwright-core (`channel: 'chrome'`, headless;
 * no bundled Chromium download). This is the tier above the in-page agent:
 * external URLs the embedded iframes can't show (X-Frame-Options, CSP,
 * cross-origin) land here.
 *
 * One engine per server process (globalThis singleton survives dev HMR);
 * one isolated context+page per scope (packetId or 'operator'), reaped after
 * 10 minutes idle. Verb envelopes mirror the in-page agent so `o8 browser`
 * output reads the same regardless of tier. The canvas browser card renders
 * a live view by polling /api/browser/engine/view.
 */

export interface EngineEnvelope {
  ok: boolean;
  [key: string]: unknown;
}

interface EngineSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

const IDLE_REAP_MS = 10 * 60 * 1000;
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
const VIEWPORT = { width: 1180, height: 740 };

interface PageState {
  title: string;
  text: string;
  interactive: Array<{ selector: string; tag: string; label: string }>;
}

/** Page-state collector as an injectable IIFE — evaluated inside the engine's
 *  headless Chrome. Embeds the shared selector source (SELECTOR_FOR_SOURCE) so
 *  the selector vocabulary matches the in-page agent exactly. The cap is baked
 *  into the script because `page.evaluate(string)` ignores the arg form. */
function collectPageStateScript(maxChars: number): string {
  return `(() => {
    ${SELECTOR_FOR_SOURCE}
    const labelFor = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const value = el.placeholder || '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      return (text || value || el.getAttribute('title') || '').slice(0, 80);
    };
    const maxChars = ${maxChars};
    const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n');
    const interactive = [];
    const nodes = document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]');
    for (const el of nodes) {
      if (interactive.length >= 60) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      interactive.push({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), label: labelFor(el) });
    }
    return {
      title: document.title,
      text: text.length > maxChars ? (text.slice(0, maxChars) + '… [truncated ' + (text.length - maxChars) + ' chars]') : text,
      interactive,
    };
  })()`;
}

/** Design-Mode grab as an injectable IIFE — embeds the shared selector + grab
 *  payload sources so an engine-tier (external-URL) grab matches the in-page
 *  agent's grab exactly. */
function grabScript(selector: string): string {
  return `(() => {
    ${SELECTOR_FOR_SOURCE}
    ${GRAB_PAYLOAD_SOURCE}
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'no element matches ' + ${JSON.stringify(selector)} };
    return { ok: true, element: buildGrabbedElement(el, selectorFor(el)) };
  })()`;
}

class BrowserEngine {
  private browserPromise: Promise<Browser> | null = null;
  private sessions = new Map<string, EngineSession>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  private async browser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ channel: 'chrome', headless: true }).then((browser) => {
        browser.on('disconnected', () => {
          this.browserPromise = null;
          this.sessions.clear();
        });
        return browser;
      }).catch((error) => {
        this.browserPromise = null;
        throw error;
      });
    }
    return this.browserPromise;
  }

  private async session(scope: string): Promise<EngineSession> {
    const existing = this.sessions.get(scope);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const browser = await this.browser();
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const session: EngineSession = { context, page, lastUsedAt: Date.now() };
    this.sessions.set(scope, session);
    if (!this.reaper) {
      this.reaper = setInterval(() => void this.reapIdle(), 60_000);
      this.reaper.unref?.();
    }
    return session;
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const [scope, session] of this.sessions) {
      if (now - session.lastUsedAt < IDLE_REAP_MS) continue;
      this.sessions.delete(scope);
      await session.context.close().catch(() => undefined);
    }
    if (this.sessions.size === 0 && this.browserPromise) {
      const browser = await this.browserPromise.catch(() => null);
      this.browserPromise = null;
      await browser?.close().catch(() => undefined);
      if (this.reaper) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }
  }

  hasSession(scope: string): boolean {
    const session = this.sessions.get(scope);
    return Boolean(session && !session.page.isClosed());
  }

  /** Cheap label data for the live-view tab — no evaluate round-trip. */
  async meta(scope: string): Promise<{ active: boolean; url?: string; title?: string }> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { active: false };
    return { active: true, url: session.page.url(), title: await session.page.title().catch(() => '') };
  }

  async open(scope: string, url: string): Promise<EngineEnvelope> {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const session = await this.session(scope);
    await session.page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    return { ok: true, url: session.page.url(), title: await session.page.title().catch(() => ''), surface: 'engine' };
  }

  async read(scope: string, maxChars?: number): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    const cap = Math.min(14_000, Math.max(400, maxChars ?? 6000));
    const state = (await session.page.evaluate(collectPageStateScript(cap))) as PageState;
    return { ok: true, url: session.page.url(), surface: 'engine', ...state };
  }

  async click(scope: string, selector: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    await session.page.click(selector, { timeout: ACTION_TIMEOUT_MS });
    return { ok: true, clicked: selector, surface: 'engine', url: session.page.url() };
  }

  async type(scope: string, selector: string, text: string, submit?: boolean): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    await session.page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
    if (submit) await session.page.press(selector, 'Enter', { timeout: ACTION_TIMEOUT_MS });
    return { ok: true, typed: text.length, into: selector, surface: 'engine', url: session.page.url() };
  }

  async grab(scope: string, selector: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    const result = (await session.page.evaluate(grabScript(selector))) as { ok: boolean; element?: GrabbedElement; error?: string };
    if (!result.ok) return { ok: false, error: result.error ?? 'grab failed', surface: 'engine', url: session.page.url() };
    return { ok: true, surface: 'engine', url: session.page.url(), element: result.element };
  }

  async probe(scope: string, selector: string, text?: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope — run `o8 browser open <url>` first' };
    session.lastUsedAt = Date.now();
    const found = await session.page.evaluate(
      ({ sel, needle }: { sel: string; needle: string | null }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (!needle) return true;
        return ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase().includes(needle.toLowerCase());
      },
      { sel: selector, needle: text ?? null },
    ).catch(() => false);
    return found ? { ok: true, found: selector, surface: 'engine' } : { ok: false, pending: true };
  }

  /** Live-view frame for the canvas card — jpeg keeps polling cheap. */
  async screenshot(scope: string): Promise<{ ok: true; jpegBase64: string; url: string; title: string } | { ok: false; error: string }> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    const shot = await session.page.screenshot({ type: 'jpeg', quality: 55 });
    return { ok: true, jpegBase64: shot.toString('base64'), url: session.page.url(), title: await session.page.title().catch(() => '') };
  }

  async close(scope: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session) return { ok: true, closed: false };
    this.sessions.delete(scope);
    await session.context.close().catch(() => undefined);
    void this.reapIdle();
    return { ok: true, closed: true };
  }
}

export function getBrowserEngine(): BrowserEngine {
  const store = globalThis as { __o8BrowserEngine?: BrowserEngine };
  if (!store.__o8BrowserEngine) store.__o8BrowserEngine = new BrowserEngine();
  return store.__o8BrowserEngine;
}
