// Real-path regression test for the worker tile header (issue #2357, phase 1).
//
// Reported failure: at roughly 200px tile width the AgentTilePane header's
// runtime/model label, status, and worker name overlap and become unreadable.
// Wider tiles render correctly.
//
// This test renders the REAL production component (src/components/desktop/
// workspace-terminal/AgentTilePane.tsx) inside headless Chromium and asserts
// on actual browser layout metrics — bounding boxes and painted text ranges —
// not on source text or jsdom stubs. Only content-bearing leaves are stubbed
// (the transcript body renderer and a browser-PiP event constant); the
// session-transform control renders for real against a stubbed window.fetch,
// so its 32px button and the 44px close control are accounted for exactly as
// production lays them out.
//
// Expected classification on unchanged main: both cases FAIL.
// Narrow (~200px): the runtime/model label neither clips nor yields — its
// glyphs paint over the status label and the header controls, the short
// worker identity does not stay fully visible, and the full model string is
// reachable through no hoverable tooltip. Roomy: layout is clean but the
// full model string is still reachable through no tooltip at any width.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import type { Plugin } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const executablePath = resolveBrowserPath();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentTilePanePath = path.join(
  repoRoot,
  'src',
  'components',
  'desktop',
  'workspace-terminal',
  'AgentTilePane.tsx',
);

// Generic fixtures — no provider names, no real session keys.
const AGENT_NAME = 'Worker 2';
const LONG_AGENT_NAME = 'Quarterly Reconciliation Worker Specimen Title';
const MODEL_FIXTURE = 'probe-model-4f2a9c7e1b8d3c5a6f0e2d4b9a7c1e3f-long-identifier';
const SESSION_KEY = 'workspace-owned:tile-specimen-alpha';

const VIEWPORT = { width: 1440, height: 900 };
const NARROW_TILE_WIDTH_PX = 200;
const MID_TILE_WIDTH_PX = 320;
const ROOMY_TILE_WIDTH_PX = 760;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface ElementMetrics {
  found: boolean;
  label: string;
  box: Box | null;
  painted: Box | null;
  paintedWidth: number;
  paintedHeight: number;
  /** Width of the element's full text-ink range (includes clipped glyphs). */
  textWidth: number;
  /** True when UNclipped text extends past the element's own box — how text paints over siblings. */
  escapesOwnBox: boolean;
  clips: boolean;
  title: string | null;
  ariaLabel: string | null;
  text: string;
}

type HeaderElementKey = 'name' | 'model' | 'status' | 'transform' | 'close';

interface HeaderMetrics {
  tileWidth: number;
  tileHeight: number;
  tileLeft: number;
  tileRight: number;
  name: ElementMetrics;
  model: ElementMetrics;
  status: ElementMetrics;
  transform: ElementMetrics;
  close: ElementMetrics;
  collisions: string[];
  escapes: string[];
  /** Full model string reachable through a hoverable (nonzero, in-row) tooltip carrier. */
  modelAccessible: boolean;
  modelCarrierCount: number;
}

// Evaluated inside the page. Finds the real header elements by structure and
// fixture text, then measures element boxes, clipped painted boxes, and
// pairwise painted collisions. Elements that clip (an ellipsized label) are
// measured as their visible part; unclipped text uses its full ink range so
// glyph overflow onto siblings is detected. SVG-only controls carry no text,
// so they are measured by their full clickable element boxes.
function measureHeaderInPage(probe: { expectedName: string; expectedModel: string }) {
  const allButtons = Array.from(document.querySelectorAll('button'));
  const closeButton = allButtons.find((button) => (button.getAttribute('aria-label') ?? '').startsWith('Close ')) ?? null;
  const transformButton = allButtons.find((button) => (button.getAttribute('aria-label') ?? '') === 'Session history controls') ?? null;
  const nameElement = Array.from(document.querySelectorAll('div')).find((el) => (
    el.getAttribute('title') === probe.expectedName
    && (el.textContent ?? '').trim() === probe.expectedName
  )) ?? null;
  const modelElement = Array.from(document.querySelectorAll('span'))
    .filter((el) => (el.textContent ?? '').includes(probe.expectedModel))
    .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0] ?? null;
  const statusElement = Array.from(document.querySelectorAll('span')).find((el) => {
    const dot = el.firstElementChild;
    if (!dot || dot.tagName !== 'SPAN') return false;
    const radius = Number.parseFloat(window.getComputedStyle(dot).borderRadius);
    return radius >= 100 && (el.textContent ?? '').trim().length > 0;
  }) ?? null;

  // The tile root is the first ancestor of the close button that clips
  // overflow (border-radius 14 card with overflow: hidden) — painted glyphs
  // are only visible inside it.
  let tileRoot: HTMLElement | null = null;
  let cursor: HTMLElement | null = closeButton;
  while (cursor && cursor !== document.body) {
    if (window.getComputedStyle(cursor).overflowX === 'hidden') {
      tileRoot = cursor;
      break;
    }
    cursor = cursor.parentElement;
  }

  function withSize(box: { left: number; top: number; right: number; bottom: number }): Box {
    return { ...box, width: box.right - box.left, height: box.bottom - box.top };
  }

  function boxOf(rect: DOMRect): Box {
    return withSize({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }

  function metricsFor(label: string, el: HTMLElement | null, useTextInk: boolean): ElementMetrics {
    if (!el) {
      return {
        found: false, label, box: null, painted: null, paintedWidth: 0, paintedHeight: 0,
        textWidth: 0, escapesOwnBox: false, clips: false, title: null, ariaLabel: null, text: '',
      };
    }
    const box = boxOf(el.getBoundingClientRect());
    const range = document.createRange();
    range.selectNodeContents(el);
    const textRect = range.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
    // Controls (SVG-only buttons) have no text ink: their painted box is the
    // full clickable element box. Text labels paint their text ink, clipped
    // to the element box when the element clips (ellipsis/overflow hidden).
    let painted: Box;
    if (!useTextInk) {
      painted = { ...box };
    } else if (!clips) {
      painted = boxOf(textRect);
    } else {
      painted = withSize({
        left: Math.max(box.left, textRect.left),
        top: Math.max(box.top, textRect.top),
        right: Math.min(box.right, textRect.right),
        bottom: Math.min(box.bottom, textRect.bottom),
      });
    }
    if (tileRoot) {
      const tileBox = tileRoot.getBoundingClientRect();
      painted = withSize({
        left: Math.max(painted.left, tileBox.left),
        top: Math.max(painted.top, tileBox.top),
        right: Math.min(painted.right, tileBox.right),
        bottom: Math.min(painted.bottom, tileBox.bottom),
      });
    }
    return {
      found: true,
      label,
      box,
      painted,
      paintedWidth: Math.max(0, painted.width),
      paintedHeight: Math.max(0, painted.height),
      textWidth: textRect.width,
      escapesOwnBox: useTextInk && !clips && (textRect.right > box.right + 1 || textRect.left < box.left - 1),
      clips,
      title: el.getAttribute('title'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.textContent ?? '').trim(),
    };
  }

  const name = metricsFor('name', nameElement, true);
  const model = metricsFor('model', modelElement, true);
  const status = metricsFor('status', statusElement, true);
  // SVG-only buttons: full clickable element boxes, never text-ink bounds.
  const transform = metricsFor('transform', transformButton, false);
  const close = metricsFor('close', closeButton, false);
  const byKey: Record<HeaderElementKey, ElementMetrics> = { name, model, status, transform, close };

  const headerRowBox = (() => {
    const anchors = [name, status].filter((entry) => entry.found && entry.box);
    if (anchors.length === 0) return null;
    return withSize({
      left: Math.min(...anchors.map((entry) => entry.box!.left)),
      top: Math.min(...anchors.map((entry) => entry.box!.top)),
      right: Math.max(...anchors.map((entry) => entry.box!.right)),
      bottom: Math.max(...anchors.map((entry) => entry.box!.bottom)),
    });
  })();

  // The full model value counts as reachable only when some element carrying
  // it as a native `title` tooltip is itself hoverable: a nonzero box that
  // overlaps the header row. A bare aria-label is not a visible tooltip, and
  // a title on a zero-size, unhoverable node does not count. This keeps the
  // model value accessible even when its own label has shrunk to nothing.
  const modelCarriers = Array.from(document.querySelectorAll('[title]'))
    .filter((el) => (el.getAttribute('title') ?? '').includes(probe.expectedModel))
    .map((el) => boxOf(el.getBoundingClientRect()));
  const modelAccessible = modelCarriers.some((carrier) => {
    if (carrier.width <= 1 || carrier.height <= 1) return false;
    if (!headerRowBox) return false;
    const overlapWidth = Math.min(carrier.right, headerRowBox.right) - Math.max(carrier.left, headerRowBox.left);
    const overlapHeight = Math.min(carrier.bottom, headerRowBox.bottom) - Math.max(carrier.top, headerRowBox.top);
    return overlapWidth > 1 && overlapHeight > 1;
  });

  const pairs: Array<[HeaderElementKey, HeaderElementKey]> = [
    ['name', 'model'],
    ['name', 'status'],
    ['model', 'status'],
    ['name', 'transform'],
    ['name', 'close'],
    ['model', 'transform'],
    ['model', 'close'],
    ['status', 'transform'],
    ['status', 'close'],
    ['transform', 'close'],
  ];
  const collisions: string[] = [];
  for (const [aKey, bKey] of pairs) {
    const a = byKey[aKey];
    const b = byKey[bKey];
    if (!a.found || !b.found) continue;
    const overlapWidth = Math.min(a.painted!.right, b.painted!.right) - Math.max(a.painted!.left, b.painted!.left);
    const overlapHeight = Math.min(a.painted!.bottom, b.painted!.bottom) - Math.max(a.painted!.top, b.painted!.top);
    if (overlapWidth > 1 && overlapHeight > 1) collisions.push(`${aKey}x${bKey}`);
  }
  const escapes = Object.values(byKey)
    .filter((entry) => entry.found && entry.escapesOwnBox)
    .map((entry) => entry.label);

  const tileBox = tileRoot ? tileRoot.getBoundingClientRect() : null;
  return {
    tileWidth: tileBox ? tileBox.width : 0,
    tileHeight: tileBox ? tileBox.height : 0,
    tileLeft: tileBox ? tileBox.left : 0,
    tileRight: tileBox ? tileBox.right : 0,
    name,
    model,
    status,
    transform,
    close,
    collisions,
    escapes,
    modelAccessible,
    modelCarrierCount: modelCarriers.length,
  } as unknown as HeaderMetrics;
}

// Stubs network endpoints at the fetch boundary so the real component tree
// can mount in a bare page with no external network: the session-transform
// control reports supported capabilities (its 32px button must occupy the
// header) and transcript bootstrap returns an empty history. Installed by
// page.evaluate AFTER the document exists and BEFORE the bundle is injected.
const FETCH_STUB_SOURCE = `
(() => {
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const json = (payload) => Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    if (url.includes('/api/runtime/session-transform')) {
      return json({
        capabilities: {
          import: { supported: true },
          checkpoint: { supported: true },
          fork: { supported: true },
          rewind: { supported: true },
        },
        catalogVersion: 1,
        pendingTransform: null,
        catalogSession: { ownership: 'operator', provenance: 'test-fixture' },
        checkpoints: [{ id: 'fixture-checkpoint-1', createdAt: '2026-01-01T00:00:00.000Z' }],
      });
    }
    if (url.includes('/api/mobile/history')) return json({ transcript: [] });
    return json({});
  };
})();
`;

// Product-accurate specimen environment: the system font stack and the light
// theme tokens the tile consumes (values from src/lib/theme/registry.ts and
// src/app/globals.css), so measured geometry represents the product rather
// than the browser's default serif fallback.
const PRODUCT_ENV_STYLE = `
:root {
  --font-sans-system: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif;
  --cortex-chat-gutter: 18px;
  --cortex-chat-column-max: 960px;
  --t-text: #0f172a;
  --t-text-strong: #020617;
  --t-text-secondary: #475569;
  --t-text-muted: #64748b;
  --t-text-faint: #94a3b8;
  --t-accent: #2563eb;
  --t-accent-border: rgba(37, 99, 235, 0.26);
  --t-border: rgba(15, 23, 42, 0.1);
  --t-border-hover: rgba(15, 23, 42, 0.2);
  --t-chat-surface-bg: #F4F2ED;
  --t-panel: #FAF9F4;
  --t-divider-subtle: rgba(15, 23, 42, 0.05);
  --t-hover: rgba(15, 23, 42, 0.04);
  --t-bg-card: rgba(15, 23, 42, 0.04);
  --t-input-bg: #FFFFFF;
}
body {
  margin: 0;
  font-family: var(--font-sans-system);
  color: var(--t-text);
  background: #F4F2ED;
}
`;

describe.skipIf(!executablePath)('AgentTilePane header layout (real browser path, #2357)', () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let tempDir: string | null = null;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-agent-tile-header-'));

    // Content-only stubs; the component tree and its header markup stay real.
    fs.writeFileSync(path.join(tempDir, 'workspace-transcript-stub.jsx'), `
import { createElement } from 'react';

export function WorkspaceTranscript({ entries }) {
  return createElement(
    'div',
    { 'data-testid': 'stub-transcript' },
    entries.map((entry) => createElement('div', { key: entry.id }, entry.text)),
  );
}
`);
    fs.writeFileSync(path.join(tempDir, 'browser-pip-stub.mjs'), `export const BROWSER_PIP_EVENT = 'o8:browser-pip';\n`);
    fs.writeFileSync(path.join(tempDir, 'server-only-stub.mjs'), 'export default {};\n');

    const entryPath = path.join(tempDir, 'entry.mjs');
    fs.writeFileSync(entryPath, `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentTilePane } from ${JSON.stringify(agentTilePanePath)};

window.__o8TileHarness = (() => {
  let dispose = null;
  return {
    mount(container, props) {
      if (dispose) { dispose(); dispose = null; }
      const root = createRoot(container);
      root.render(createElement(AgentTilePane, {
        focused: true,
        onClose: () => {},
        onFocus: () => {},
        ...props,
      }));
      dispose = () => { root.unmount(); container.textContent = ''; };
    },
    dispose() {
      if (dispose) { dispose(); dispose = null; }
    },
  };
})();
`);

    // Resolve @/ imports from this repo's src tree. Stub resolvers are
    // registered BEFORE the alias so they win for their specific modules.
    const resolveSrcFile = (rel: string): string => {
      const base = path.join(repoRoot, 'src', rel);
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.mjs`,
        `${base}.js`,
        path.join(base, 'index.ts'),
        path.join(base, 'index.tsx'),
      ];
      for (const candidate of candidates) {
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // fall through to the next candidate extension
        }
      }
      throw new Error(`Cannot resolve src module for alias: ${rel}`);
    };
    const aliasPlugin: Plugin = {
      name: 'o8-tile-header-alias',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/WorkspaceTranscript$/ }, () => ({
          path: path.join(tempDir!, 'workspace-transcript-stub.jsx'),
        }));
        builder.onResolve({ filter: /BrowserPipCard$/ }, () => ({
          path: path.join(tempDir!, 'browser-pip-stub.mjs'),
        }));
        builder.onResolve({ filter: /^server-only$/ }, () => ({
          path: path.join(tempDir!, 'server-only-stub.mjs'),
        }));
        builder.onResolve({ filter: /^@\/.+/ }, (args) => ({
          path: resolveSrcFile(args.path.slice(2)),
        }));
      },
    };

    const bundlePath = path.join(tempDir, 'agent-tile.bundle.js');
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome120'],
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      outfile: bundlePath,
      plugins: [aliasPlugin],
      // The entry file lives in a temp dir; resolve react/react-dom from the
      // worktree's installed dependencies.
      nodePaths: [path.join(repoRoot, 'node_modules')],
      legalComments: 'none',
      logLevel: 'silent',
    });
    const bundleCode = fs.readFileSync(bundlePath, 'utf8');

    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${PRODUCT_ENV_STYLE}</style></head><body></body></html>`);
    // Install the fetch fixture in the existing document, before any
    // component can mount (addInitScript does not run for setContent).
    await page.evaluate(FETCH_STUB_SOURCE);
    await page.addScriptTag({ content: bundleCode });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    browser = null;
    page = null;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function mountAndMeasure(tileWidthPx: number, agentName: string = AGENT_NAME): Promise<HeaderMetrics> {
    if (!page) throw new Error('browser page was not initialized');
    await page.evaluate((setup: { tileWidthPx: number; sessionKey: string; name: string; model: string }) => {
      const harness = (window as unknown as {
        __o8TileHarness: {
          mount: (container: HTMLElement, props: Record<string, unknown>) => void;
          dispose: () => void;
        };
      }).__o8TileHarness;
      // Fresh container per mount: React rejects re-rooting the same node.
      harness.dispose();
      document.getElementById('o8-tile-header-host')?.remove();
      const host = document.createElement('div');
      host.id = 'o8-tile-header-host';
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.minHeight = '120px';
      host.style.width = `${setup.tileWidthPx}px`;
      document.body.appendChild(host);
      harness.mount(host, {
        sessionKey: setup.sessionKey,
        agent: { name: setup.name, status: 'running', model: setup.model },
        packet: null,
        focused: true,
      });
    }, { tileWidthPx, sessionKey: SESSION_KEY, name: agentName, model: MODEL_FIXTURE });

    // Wait until the real header has fully mounted: close control and session
    // transform control (the latter renders one fetch-turn after mount).
    // Absent layout can never satisfy this; the model label is deliberately
    // not required, since dropping it is an accepted narrow-width behavior.
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const closeButton = buttons.find((button) => (button.getAttribute('aria-label') ?? '').startsWith('Close '));
      const transformButton = buttons.find((button) => (button.getAttribute('aria-label') ?? '') === 'Session history controls');
      return Boolean(closeButton && transformButton);
    }, undefined, { timeout: 20_000 });

    // Let fonts settle and layout/paint run two frames before measuring.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    return await page.evaluate(
      measureHeaderInPage,
      { expectedName: agentName, expectedModel: MODEL_FIXTURE },
    ) as unknown as HeaderMetrics;
  }

  function expectRenderedBox(metrics: HeaderMetrics, key: HeaderElementKey): ElementMetrics {
    const element = metrics[key];
    expect(element.found, `${key} element was not rendered in the tile header`).toBe(true);
    expect(element.box, `${key} element had no layout box`).not.toBeNull();
    expect(element.box!.width, `${key} element box width was empty (non-layout environment or invisible control)`).toBeGreaterThan(1);
    expect(element.box!.height, `${key} element box height was empty`).toBeGreaterThan(1);
    return element;
  }

  function expectTextLabel(metrics: HeaderMetrics, key: HeaderElementKey): ElementMetrics {
    const element = expectRenderedBox(metrics, key);
    expect(element.text.length, `${key} label rendered with empty text`).toBeGreaterThan(0);
    return element;
  }

  function assertRealTileLayout(metrics: HeaderMetrics, expectedWidthPx: number) {
    expect(metrics.tileWidth, 'tile did not lay out at the requested width').toBeGreaterThanOrEqual(expectedWidthPx - 2);
    expect(metrics.tileWidth, 'tile width diverged from the requested width').toBeLessThanOrEqual(expectedWidthPx + 2);
    expect(metrics.tileHeight, 'tile collapsed vertically (non-layout environment)').toBeGreaterThan(30);
  }

  function assertHeaderControls(metrics: HeaderMetrics) {
    // SVG-only controls carry no text; they are measured as clickable boxes.
    expectRenderedBox(metrics, 'transform');
    expectRenderedBox(metrics, 'close');
  }

  function assertNoPaintedCollisions(metrics: HeaderMetrics) {
    expect(
      metrics.escapes,
      'unclipped header text extends past its own element box and paints over siblings',
    ).toEqual([]);
    expect(
      metrics.collisions,
      'header labels/controls paint over each other',
    ).toEqual([]);
  }

  function assertModelAccessible(metrics: HeaderMetrics) {
    expect(
      metrics.modelAccessible,
      `full model string is not reachable: ${metrics.modelCarrierCount} tooltip carrier(s) carry it, none of them hoverable within the header row`,
    ).toBe(true);
  }

  function assertHorizontallyContained(metrics: HeaderMetrics) {
    for (const key of ['name', 'model', 'status', 'transform', 'close'] as const) {
      const element = metrics[key];
      if (!element.found || !element.box) continue;
      expect(
        element.box.left,
        `${key} element paints left of the tile`,
      ).toBeGreaterThanOrEqual(metrics.tileLeft - 1);
      expect(
        element.box.right,
        `${key} element paints past the tile horizontally (vertical overshoot of the 44px close hit target is intentional)`,
      ).toBeLessThanOrEqual(metrics.tileRight + 1);
    }
  }

  it('keeps the worker identity fully visible at ~200px: status stays, model yields accessibly, nothing collides', async () => {
    const metrics = await mountAndMeasure(NARROW_TILE_WIDTH_PX, AGENT_NAME);
    assertRealTileLayout(metrics, NARROW_TILE_WIDTH_PX);
    assertHeaderControls(metrics);
    assertHorizontallyContained(metrics);

    const name = expectTextLabel(metrics, 'name');
    expect(name.text, 'worker name element does not carry the fixture identity').toBe(AGENT_NAME);
    expect(name.title, 'full worker identity is not reachable via the name tooltip').toBe(AGENT_NAME);
    expect(name.textWidth, 'worker name rendered with no text ink').toBeGreaterThan(5);
    // Subpixel tolerance only: a 0.22px shrink already renders CSS ellipsis
    // and truncates the identity, so any real flex-shrink must fail here.
    expect(
      name.paintedWidth,
      'short worker identity is not fully visible at ~200px (subpixel truncation renders ellipsis)',
    ).toBeGreaterThanOrEqual(name.textWidth - 0.1);

    const status = expectTextLabel(metrics, 'status');
    expect(
      status.paintedWidth,
      'status label has no visible painted width at ~200px (model must yield before status)',
    ).toBeGreaterThan(2);

    // The model label may be clipped or fully dropped at this width, but its
    // full value must stay reachable through a hoverable tooltip.
    assertModelAccessible(metrics);
    assertNoPaintedCollisions(metrics);
  });

  it('yields the model before the status at ~320px: full status dot/caption, clipped model, full identity', async () => {
    const metrics = await mountAndMeasure(MID_TILE_WIDTH_PX, AGENT_NAME);
    assertRealTileLayout(metrics, MID_TILE_WIDTH_PX);
    assertHeaderControls(metrics);
    assertHorizontallyContained(metrics);

    const name = expectTextLabel(metrics, 'name');
    expect(name.text, 'worker name element does not carry the fixture identity').toBe(AGENT_NAME);
    expect(
      name.paintedWidth,
      'short worker identity is not fully visible at ~320px',
    ).toBeGreaterThanOrEqual(name.textWidth - 0.1);

    // Priority contract: the status renders FULL (dot + caption, zero
    // truncation) while the model label is the metadata that yields.
    const status = expectTextLabel(metrics, 'status');
    expect(
      status.paintedWidth,
      'status label is truncated at ~320px while the model label still occupies width — model must yield first',
    ).toBeGreaterThanOrEqual(status.textWidth - 0.1);

    // A clipped or fully hidden model label is permitted; its full value must
    // stay reachable through a hoverable tooltip.
    assertModelAccessible(metrics);
    assertNoPaintedCollisions(metrics);
  });

  it('bounds a long identity at ~200px: title truncates, but controls, status indicator, and model access survive', async () => {
    const metrics = await mountAndMeasure(NARROW_TILE_WIDTH_PX, LONG_AGENT_NAME);
    assertRealTileLayout(metrics, NARROW_TILE_WIDTH_PX);
    assertHeaderControls(metrics);
    assertHorizontallyContained(metrics);

    const name = expectTextLabel(metrics, 'name');
    expect(name.text, 'worker name element does not carry the fixture identity').toBe(LONG_AGENT_NAME);
    expect(name.title, 'full long identity is not reachable via the name tooltip').toBe(LONG_AGENT_NAME);
    expect(
      name.paintedWidth,
      'long identity should be truncated at ~200px',
    ).toBeLessThan(name.textWidth - 1);
    expect(
      name.paintedWidth,
      'truncated long identity must stay inside its own clip box (no painted overflow)',
    ).toBeGreaterThan(2);

    const status = expectTextLabel(metrics, 'status');
    expect(
      status.paintedWidth,
      'status indicator (dot at minimum) must stay visible beside a long identity',
    ).toBeGreaterThan(2);

    assertModelAccessible(metrics);
    assertNoPaintedCollisions(metrics);
  });

  it('keeps the roomy tile header fully painted, collision-free, and tooltip-reachable', async () => {
    const metrics = await mountAndMeasure(ROOMY_TILE_WIDTH_PX, AGENT_NAME);
    assertRealTileLayout(metrics, ROOMY_TILE_WIDTH_PX);
    assertHeaderControls(metrics);
    assertHorizontallyContained(metrics);

    const name = expectTextLabel(metrics, 'name');
    expect(name.text, 'worker name element does not carry the fixture identity').toBe(AGENT_NAME);
    expect(
      name.paintedWidth,
      'worker name should not need truncation at roomy width',
    ).toBeGreaterThanOrEqual(name.textWidth - 0.1);

    const model = expectTextLabel(metrics, 'model');
    expect(model.text, 'runtime/model label does not carry the fixture model').toContain(MODEL_FIXTURE);
    expect(
      model.paintedWidth,
      'runtime/model label should render in full at roomy width',
    ).toBeGreaterThanOrEqual(model.textWidth - 0.1);

    const status = expectTextLabel(metrics, 'status');
    expect(status.paintedWidth, 'status label has no visible painted width at roomy width').toBeGreaterThan(2);

    assertModelAccessible(metrics);
    assertNoPaintedCollisions(metrics);
  });
});
