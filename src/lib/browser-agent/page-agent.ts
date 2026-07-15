'use client';

/**
 * In-page browser agent (#1232 phase 1) — first-party browser control for
 * agents, against o8's OWN embedded browser surfaces (canvas browser cards
 * and the default-side Browser pane). Same-origin pages only — which, with
 * the embedded browser's live proxy, means any localhost page.
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
import { buildGrabbedElement } from '@/lib/browser/grab';
import { collectBrowserLocalizationRows, type BrowserLocalizationRect } from '@/lib/browser/localization';

export interface BrowserAgentTarget {
  /** 'canvas' (browser cards) or 'panel' (default-side Browser tab). */
  surface?: 'canvas' | 'panel';
}

interface AgentElementRow {
  selector: string;
  tag: string;
  label: string;
}

const PROXY_MARKERS = ['/api/browser/proxy?url='];

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

/** The spectator layer — a PERSISTENT ghost cursor that glides to each target
 *  the agent acts on (Claude-in-Chrome style), ripples on contact, and fades
 *  after the agent goes idle. One per document, reused across actions so the
 *  motion reads as one continuous cursor moving on the live page.
 *  pointer-events:none — it never blocks the human's own pointer on the same
 *  surface (the human + agent share the page). */
const cursorByDoc = new WeakMap<Document, { cursor: HTMLDivElement; ripple: HTMLDivElement; hideTimer: ReturnType<typeof setTimeout> | null }>();

function ensureCursor(doc: Document) {
  const existing = cursorByDoc.get(doc);
  if (existing && doc.body.contains(existing.cursor)) return existing;
  const cursor = doc.createElement('div');
  cursor.setAttribute('data-o8-agent-cursor', 'true');
  cursor.setAttribute('style', [
    'position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%',
    'background:rgba(245,158,11,0.9);border:2px solid rgba(255,255,255,0.95)',
    'box-shadow:0 0 0 4px rgba(245,158,11,0.22), 0 2px 10px rgba(0,0,0,0.4)',
    'z-index:2147483600;pointer-events:none;opacity:0;transform:translate(-50%,-50%)',
    'transition:left 320ms cubic-bezier(0.22,1,0.36,1),top 320ms cubic-bezier(0.22,1,0.36,1),opacity 220ms ease-out',
  ].join(';'));
  const ripple = doc.createElement('div');
  ripple.setAttribute('data-o8-agent-cursor-ripple', 'true');
  ripple.setAttribute('style', [
    'position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%',
    'border:2px solid rgba(245,158,11,0.7)',
    'z-index:2147483599;pointer-events:none;opacity:0;transform:translate(-50%,-50%)',
  ].join(';'));
  doc.body.appendChild(cursor);
  doc.body.appendChild(ripple);
  const state = { cursor, ripple, hideTimer: null as ReturnType<typeof setTimeout> | null };
  cursorByDoc.set(doc, state);
  return state;
}

function paintCursor(doc: Document, x: number, y: number) {
  try {
    const state = ensureCursor(doc);
    const { cursor, ripple } = state;
    const left = `${Math.round(x)}px`;
    const top = `${Math.round(y)}px`;
    cursor.style.opacity = '1';
    cursor.style.left = left;
    cursor.style.top = top;
    ripple.style.left = left;
    ripple.style.top = top;
    if (typeof ripple.animate === 'function') {
      ripple.animate(
        [{ transform: 'translate(-50%,-50%) scale(0.7)', opacity: 0.8 }, { transform: 'translate(-50%,-50%) scale(3.2)', opacity: 0 }],
        { duration: 520, easing: 'ease-out' },
      );
    }
    if (state.hideTimer) clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => { cursor.style.opacity = '0'; }, 2400);
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
  return { ok: false as const, error: `page is cross-origin (${realUrl(frame.src).slice(0, 120)}) — the embedded browser drives same-origin/proxied local pages; for external URLs use the engine tier (surface: engine)`, url: realUrl(frame.src) };
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

function hostRect(frame: HTMLIFrameElement, rect: BrowserLocalizationRect): BrowserLocalizationRect {
  const outer = frame.getBoundingClientRect();
  const doc = frameDoc(frame);
  const pageWidth = doc?.defaultView?.innerWidth ?? outer.width;
  const pageHeight = doc?.defaultView?.innerHeight ?? outer.height;
  const scaleX = pageWidth > 0 ? outer.width / pageWidth : 1;
  const scaleY = pageHeight > 0 ? outer.height / pageHeight : 1;
  const left = Math.max(0, outer.left + rect.left * scaleX);
  const top = Math.max(0, outer.top + rect.top * scaleY);
  const right = Math.min(window.innerWidth, outer.left + (rect.left + rect.width) * scaleX);
  const bottom = Math.min(window.innerHeight, outer.top + (rect.top + rect.height) * scaleY);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function localize(args?: BrowserAgentTarget) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc?.body) return crossOrigin(frame);
  const interactive = collectBrowserLocalizationRows(doc.body, selectorFor, labelFor)
    .map((row) => ({ ...row, rect: hostRect(frame, row.rect) }))
    .filter((row) => row.rect.width >= 4 && row.rect.height >= 4);
  return {
    ok: true as const,
    url: realUrl(frame.src),
    surface: frame.dataset.o8Browser ?? null,
    coordinateSpace: 'host-viewport',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    interactive,
  };
}

function rect(args: BrowserAgentTarget & { selector: string }) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc?.body) return crossOrigin(frame);
  const element = doc.querySelector(args.selector);
  if (!element) return { ok: false as const, error: `no element matches ${args.selector}` };
  const row = collectBrowserLocalizationRows(
    { ownerDocument: doc, querySelectorAll: () => [element] } as unknown as ParentNode,
    selectorFor,
    labelFor,
    1,
  )[0];
  if (!row) return { ok: false as const, error: `element is not visibly actionable: ${args.selector}` };
  const mappedRect = hostRect(frame, row.rect);
  if (mappedRect.width < 4 || mappedRect.height < 4) {
    return { ok: false as const, error: `element is outside the visible browser surface: ${args.selector}` };
  }
  return {
    ok: true as const,
    surface: frame.dataset.o8Browser ?? null,
    coordinateSpace: 'host-viewport',
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...row,
    rect: mappedRect,
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

/** Design-Mode grab — capture the rich payload (structure + design styles +
 *  a11y) for one element on the live same-origin page. */
function grab(args: BrowserAgentTarget & { selector: string }) {
  const frame = pickFrame(args);
  if (!frame) return noFrame(args);
  const doc = frameDoc(frame);
  if (!doc || !doc.body) return crossOrigin(frame);
  const el = doc.querySelector(args.selector);
  if (!el) return { ok: false as const, error: `no element matches ${args.selector}` };
  const rect = el.getBoundingClientRect();
  paintCursor(doc, rect.left + rect.width / 2, rect.top + rect.height / 2);
  pulse(frame);
  return { ok: true as const, surface: frame.dataset.o8Browser ?? null, element: buildGrabbedElement(el, selectorFor(el)) };
}

export interface O8BrowserAgent {
  read: typeof read;
  localize: typeof localize;
  rect: typeof rect;
  click: typeof click;
  type: typeof type;
  probe: typeof probe;
  grab: typeof grab;
}

declare global {
  interface Window {
    __o8BrowserAgent?: O8BrowserAgent;
  }
}

/** Idempotent — both browser surfaces call this on mount. */
export function installBrowserAgent(): void {
  if (typeof window === 'undefined' || window.__o8BrowserAgent) return;
  window.__o8BrowserAgent = { read, localize, rect, click, type, probe, grab };
}
