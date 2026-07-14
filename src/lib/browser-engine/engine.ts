import 'server-only';

// TYPE-ONLY import: erased at compile time, so it pulls nothing into the bundle.
//
// The runtime `chromium` value is loaded lazily in `browser()` below. It used to
// be a static import, which dragged all of playwright-core onto the SERVER'S BOOT
// PATH — a browser-automation library, fully required before the app would answer
// its first HTTP request. It cost 126ms of self time in a CPU profile of the
// boot, plus its share of the 491ms the CJS loader spent reading and compiling
// modules off disk.
//
// Nothing here needs a browser until someone actually drives one.
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { SELECTOR_FOR_SOURCE } from '@/lib/browser/selector';
import { GRAB_PAYLOAD_SOURCE, type GrabbedElement } from '@/lib/browser/grab';
import { ENGINE_VIEWPORT } from '@/lib/browser/engine-viewport';
import { assertPublicHttpUrl } from '@/lib/network/safe-url';

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
const VIEWPORT = { width: ENGINE_VIEWPORT.width, height: ENGINE_VIEWPORT.height };

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
      // Lazy — this is the ONLY place the playwright runtime is needed, and it
      // only runs when an agent actually asks for a browser. Keeping it out of
      // the module graph keeps it off the server's boot path.
      //
      // The static import used to be resolved at BUILD time; this one resolves at
      // RUNTIME, so a packaging regression (playwright-core missing from
      // Resources/server/node_modules because Next's file tracing stopped
      // following it) would no longer be a build error — it would be a failure the
      // first time an agent asked for a browser, in production. Name the module in
      // the error so that failure is loud and obvious instead of a mystery hang.
      let chromium: typeof import('playwright-core').chromium;
      try {
        ({ chromium } = await import('playwright-core'));
      } catch (cause) {
        throw new Error(
          '[browser-engine] could not load `playwright-core` at runtime. In a packaged '
          + 'build it must exist at Resources/server/node_modules/playwright-core — if it '
          + "is missing, Next's output file tracing has stopped following the dynamic "
          + 'import in browser-engine/engine.ts. The browser engine is unavailable.',
          { cause },
        );
      }
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
    // Validate every HTTP request, not only the initial navigation. Redirects,
    // subresources, and clicked links can otherwise pivot a public page into a
    // loopback, RFC1918, or cloud-metadata target after the first check.
    await context.route('**/*', async (route) => {
      try {
        const requestUrl = route.request().url();
        const protocol = new URL(requestUrl).protocol;
        if (protocol === 'http:' || protocol === 'https:') {
          await assertPublicHttpUrl(requestUrl);
        } else if (!['about:', 'blob:', 'data:'].includes(protocol)) {
          throw new Error('Browser request scheme is not allowed.');
        }
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
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
    const validated = await assertPublicHttpUrl(target);
    const session = await this.session(scope);
    await session.page.goto(validated.toString(), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
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

  // ── Coordinate-based interaction (the panel live-view forwards the human's
  //    clicks/keys/scroll here so auth-gated apps the iframe can't embed stay
  //    usable — sign in, navigate — inside the engine's real Chrome). ──

  async clickAt(scope: string, x: number, y: number): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.mouse.click(x, y);
    return { ok: true, clickedAt: { x, y }, surface: 'engine', url: session.page.url() };
  }

  async typeText(scope: string, text: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.keyboard.type(text, { delay: 8 });
    return { ok: true, typed: text.length, surface: 'engine', url: session.page.url() };
  }

  async pressKey(scope: string, key: string): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.keyboard.press(key);
    return { ok: true, pressed: key, surface: 'engine', url: session.page.url() };
  }

  async scrollBy(scope: string, deltaY: number): Promise<EngineEnvelope> {
    const session = this.sessions.get(scope);
    if (!session || session.page.isClosed()) return { ok: false, error: 'no engine page open for this scope' };
    session.lastUsedAt = Date.now();
    await session.page.mouse.wheel(0, deltaY);
    return { ok: true, scrolled: deltaY, surface: 'engine', url: session.page.url() };
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
