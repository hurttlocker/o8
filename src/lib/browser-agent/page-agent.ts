'use client';

/**
 * In-page browser agent (#1232 phase 1) — first-party browser control for
 * agents, against o8's OWN embedded browser surfaces (canvas browser cards
 * and the default-side Browser pane). Same-origin pages only — which, with
 * the picker proxies, means any localhost page.
 *
 * Installed as `window.__o8BrowserAgent` by whichever browser surface
 * mounts first (idempotent). Callers reach it through evals: the operator
 * MCP tools (o8_browser_*) and the gated /api/browser/agent route (which
 * backs the `o8 browser` CLI for dispatched workers).
 *
 * Every verb is synchronous DOM work — the eval bridge can't await — and
 * returns a JSON-ready envelope. Actions paint the ghost cursor + ripple
 * inside the page and pulse the host surface (o8:browser-agent-pulse), so
 * the operator literally watches the agent work.
 */

import { selectorFor } from '@/lib/browser/selector';

export interface BrowserAgentTarget {
  /** 'canvas' (browser cards) or 'panel' (default-side Browser tab). */
  surface?: 'canvas' | 'panel';
}

interface AgentElementRow {
  selector: string;
  tag: string;
  label: string;
}

const PROXY_MARKERS = ['/api/browser/proxy?url=', '/api/panel/iframe-proxy?'];

function realUrl(raw: string): string {
  for (const marker of PROXY_MARKERS) {
    const index = raw.indexOf(marker);
    if (index === -1) continue;
    const params = raw.slice(raw.indexOf('?', index) + 1);
    const url = new URLSearchParams(params).get('url');
    if (url) return url;
  }
  return raw;
}

/** Active browser iframe — explicit surface first, else the last active
 *  one in DOM order (newest card wins). */
function pickFrame(target?: BrowserAgentTarget): HTMLIFrameElement | null {
  const scope = target?.surface ? `iframe[data-o8-browser="${target.surface}"]` : 'iframe[data-o8-browser]';
  const frames = [...document.querySelectorAll<HTMLIFrameElement>(scope)];
  if (!frames.length) return null;
  const active = frames.filter((frame) => frame.dataset.o8Active === 'true');
  return (active.length ? active : frames)[active.length ? active.length - 1 : frames.length - 1];
}

function frameDoc(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument ?? null;
  } catch {
    return null;
  }
}

function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const value = (el as HTMLInputElement).placeholder ?? '';
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return (text || value || el.getAttribute('title') || '').slice(0, 80);
}

/** The spectator layer — a ghost cursor glides in, ripples, fades. */
function paintCursor(doc: Document, x: number, y: number) {
  try {
    const cursor = doc.createElement('div');
    cursor.setAttribute('style', [
      'position:fixed', `left:${Math.round(x)}px`, `top:${Math.round(y)}px`,
      'width:14px;height:14px;border-radius:50%',
      'background:rgba(245,158,11,0.85);border:2px solid rgba(255,255,255,0.9)',
      'box-shadow:0 0 0 4px rgba(245,158,11,0.25), 0 2px 8px rgba(0,0,0,0.35)',
      'z-index:2147483600;pointer-events:none;transform:translate(-50%,-50%)',
    ].join(';'));
    doc.body.appendChild(cursor);
    const ripple = doc.createElement('div');
    ripple.setAttribute('style', [
      'position:fixed', `left:${Math.round(x)}px`, `top:${Math.round(y)}px`,
      'width:14px;height:14px;border-radius:50%',
      'border:2px solid rgba(245,158,11,0.7)',
      'z-index:2147483599;pointer-events:none;transform:translate(-50%,-50%)',
    ].join(';'));
    doc.body.appendChild(ripple);
    if (typeof ripple.animate === 'function') {
      ripple.animate(
        [{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(3.4)', opacity: 0 }],
        { duration: 480, easing: 'ease-out' },
      );
      cursor.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }],
        { duration: 900, easing: 'ease-out' },
      );
    }
    setTimeout(() => { cursor.remove(); ripple.remove(); }, 950);
  } catch {
    // theater is best-effort
  }
}

/** Surface pulse — hosts (cards / pane) flash an "agent driving" glow. */
function pulse(frame: HTMLIFrameElement) {
  try {
    window.dispatchEvent(new CustomEvent('o8:browser-agent-pulse', {
      detail: { surface: frame.dataset.o8Browser ?? null },
    }));
  } catch {
    // best-effort
  }
}

function noFrame(target?: BrowserAgentTarget) {
  return { ok: false as const, error: target?.surface ? `no ${target.surface} browser is open` : 'no browser surface is open — open a browser card or the Browser tab first' };
}

function crossOrigin(frame: HTMLIFrameElement) {
  return { ok: false as const, error: `page is cross-origin (${realUrl(frame.src).slice(0, 120)}) — only local pages can be driven; reopen through the picker proxy or use a localhost URL`, url: realUrl(frame.src) };
}

function read(args?: BrowserAgentTarget & { selector?: string; maxChars?: number }) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc || !doc.body) return crossOrigin(frame);
  const root: Element = args?.selector ? (doc.querySelector(args.selector) ?? doc.body) : doc.body;
  const maxChars = Math.min(14_000, Math.max(400, args?.maxChars ?? 6000));
  const text = ((root as HTMLElement).innerText ?? root.textContent ?? '').replace(/\n{3,}/g, '\n\n');
  const interactive: AgentElementRow[] = [];
  const nodes = root.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]');
  for (const el of nodes) {
    if (interactive.length >= 60) break;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    interactive.push({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), label: labelFor(el) });
  }
  pulse(frame);
  return {
    ok: true as const,
    url: realUrl(frame.src),
    title: doc.title,
    surface: frame.dataset.o8Browser ?? null,
    text: text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]` : text,
    interactive,
  };
}

function click(args: BrowserAgentTarget & { selector: string }) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc || !doc.body) return crossOrigin(frame);
  const el = doc.querySelector(args.selector) as HTMLElement | null;
  if (!el) return { ok: false as const, error: `no element matches ${args.selector}` };
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  paintCursor(doc, x, y);
  pulse(frame);
  // Full sequence — React apps inside the frame listen at pointer level.
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: doc.defaultView ?? undefined };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch { /* PointerEvent may be absent */ }
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch { /* ditto */ }
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return { ok: true as const, clicked: args.selector, label: labelFor(el) };
}

function type(args: BrowserAgentTarget & { selector: string; text: string; submit?: boolean }) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc || !doc.body) return crossOrigin(frame);
  const el = doc.querySelector(args.selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return { ok: false as const, error: `no element matches ${args.selector}` };
  const rect = el.getBoundingClientRect();
  paintCursor(doc, rect.left + Math.min(24, rect.width / 2), rect.top + rect.height / 2);
  pulse(frame);
  el.focus();
  const win = doc.defaultView ?? window;
  const proto = el.tagName === 'TEXTAREA'
    ? (win as typeof window).HTMLTextAreaElement.prototype
    : (win as typeof window).HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, args.text);
  else el.value = args.text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (args.submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const form = el.closest('form');
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
  }
  return { ok: true as const, typed: args.text.length, into: args.selector };
}

/** One poll probe — the caller (node side) loops this until ok or timeout. */
function probe(args: BrowserAgentTarget & { selector: string; text?: string }) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc || !doc.body) return crossOrigin(frame);
  const el = doc.querySelector(args.selector);
  if (!el) return { ok: false as const, pending: true };
  if (args.text && !(el.textContent ?? '').includes(args.text)) return { ok: false as const, pending: true };
  return { ok: true as const, found: args.selector };
}

export interface O8BrowserAgent {
  read: typeof read;
  click: typeof click;
  type: typeof type;
  probe: typeof probe;
}

declare global {
  interface Window {
    __o8BrowserAgent?: O8BrowserAgent;
  }
}

/** Idempotent — both browser surfaces call this on mount. */
export function installBrowserAgent(): void {
  if (typeof window === 'undefined' || window.__o8BrowserAgent) return;
  window.__o8BrowserAgent = { read, click, type, probe };
}
