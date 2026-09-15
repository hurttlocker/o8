// Real-path regression test for the composer selector chip row (issue #2358, phase 1).
//
// Reported failure: in Multitask mode the Lead chip and Workers chip collide near
// ~400px, the Lead label shrinks to nothing, and controls become unreachable.
// This renders the REAL footer through InputButtons in headless Chromium and
// asserts on browser boxes, clip-aware painted unions, and hit-test reachability.
// Only unrelated persistence/store, entitlement context, and fetch are stubbed.
// Expected on unchanged main: the narrow cases fail (escape/overlap, no readable
// lead prefix, hint not collapsing). If the collision is absent, report that.

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
const inputButtonsPath = path.join(repoRoot, 'src', 'components', 'desktop', 'thoughts', 'InputButtons.tsx');
const contextMeterPath = path.join(repoRoot, 'src', 'components', 'desktop', 'orchestrator', 'ContextMeter.tsx');
const selectorStateHookPath = path.join(
  repoRoot,
  'src',
  'components',
  'desktop',
  'thoughts',
  'composer-selector',
  'useComposerSelectorState.ts',
);

// Generic public fixtures — no real provider ids, no session keys.
const LONG_MODEL_LABEL = 'Probe Specimen 4F2A9C7E';
const LONG_MODEL_ID = 'codex-probe-orchestrator-specimen-4f2a9c7e';
// Real registry label for the `claude-code` dispatch runtime (a longer Workers
// chip than the terse "Codex" default).
const WORKER_RUNTIME_LABEL = 'Claude Code';
const THREAD_ID = 'fixture-thread';
const REPO_LABEL = 'Fixture Repo';
const proofDir = process.env.O8_COMPOSER_PROOF_DIR?.trim() || null;

const VIEWPORT = { width: 1440, height: 900 };
const NARROW_COMPOSER_WIDTH_PX = 380;
const NARROWER_COMPOSER_WIDTH_PX = 340;
const ROOMY_COMPOSER_WIDTH_PX = 900;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface ControlMetrics {
  found: boolean;
  box: Box | null;
  /** Clipping-aware union of descendant layout boxes — what actually paints. */
  painted: Box | null;
  /** True when painted content extends past the control's own border box. */
  escapes: boolean;
  title: string | null;
  ariaLabel: string | null;
  text: string;
  /** Center of the interactive target hit-tests back into the control. */
  reachable: boolean;
}

interface ComposerMetrics {
  requestedWidth: number;
  footer: Box | null;
  controls: Record<string, ControlMetrics>;
  boxOverlaps: string[];
  contentOverlaps: string[];
  escapes: string[];
  modelReachableViaTitle: boolean;
  leadIdentityPaintedWidth: number;
  leadLabelPaintedWidth: number;
  leadLabelTextWidth: number;
  leadLabelFull: boolean;
  modeHintVisible: boolean;
  meterPaintedWidth: number;
  meterFullWidth: number;
  effortWordText: string;
  workersLabelText: string;
}

const CONTROL_KEYS = ['mode', 'attach', 'leading', 'meter', 'lead', 'workers', 'voice', 'send'] as const;
const REQUIRED_CONTROLS = ['mode', 'attach', 'meter', 'lead', 'workers', 'voice', 'send'] as const;

// Evaluated inside the page (serialized by Playwright — it must not reference
// any outer-scope binding). Finds the real footer controls by their production
// test ids, measures each control's border box and the clip-aware painted union
// of its descendants' element boxes AND text ink ranges, and hit-tests each
// interactive center. Text clipped to nothing contributes nothing; text painted
// over a sibling is measured.
function measureComposerInPage(probe: { modelLabel: string }): ComposerMetrics {
  const KEYS = ['mode', 'attach', 'leading', 'meter', 'lead', 'workers', 'voice', 'send'];

  function withSize(box: { left: number; top: number; right: number; bottom: number }): Box {
    return { ...box, width: box.right - box.left, height: box.bottom - box.top };
  }

  function boxOf(rect: DOMRect): Box {
    return withSize({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }

  function overlapArea(a: Box, b: Box): number {
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  function intersection(a: Box, b: Box): Box | null {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right - left <= 0.5 || bottom - top <= 0.5) return null;
    return withSize({ left, top, right, bottom });
  }

  // Every overflow-clipping ancestor's box for a node. An element's own overflow
  // clips its descendants, not its own box, so element nodes start at the parent.
  function clippingAncestorBoxes(node: Node): Box[] {
    const boxes: Box[] = [];
    let cursor: Element | null = node.nodeType === Node.ELEMENT_NODE
      ? (node as Element).parentElement
      : node.parentElement;
    while (cursor && cursor !== document.body) {
      const style = window.getComputedStyle(cursor);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        boxes.push(boxOf(cursor.getBoundingClientRect()));
      }
      cursor = cursor.parentElement;
    }
    return boxes;
  }

  // Real painted rects for a node: an element's border box, or the text ink
  // ranges for a text node (per client rect, so each wrapped line is honest).
  function nodeRects(node: Node): Box[] {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!(node.textContent ?? '').trim()) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      return Array.from(range.getClientRects())
        .map(boxOf)
        .filter((box) => box.width > 0.5 && box.height > 0.5);
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const rect = (node as Element).getBoundingClientRect();
      if (rect.width <= 0.5 || rect.height <= 0.5) return [];
      return [boxOf(rect)];
    }
    return [];
  }

  // Union of every descendant's painted rect, clipped by ALL clipping ancestors
  // (and nested clips), so hidden text contributes nothing. getBoundingClientRect
  // ignores overflow clipping, so the clipping is applied explicitly here.
  function paintedUnion(el: Element): Box | null {
    let minLeft = Number.POSITIVE_INFINITY;
    let minTop = Number.POSITIVE_INFINITY;
    let maxRight = Number.NEGATIVE_INFINITY;
    let maxBottom = Number.NEGATIVE_INFINITY;
    let any = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const clips = clippingAncestorBoxes(node);
      for (const raw of nodeRects(node)) {
        let box: Box | null = raw;
        for (const clip of clips) {
          box = box ? intersection(box, clip) : null;
          if (!box) break;
        }
        if (!box) continue;
        any = true;
        minLeft = Math.min(minLeft, box.left);
        minTop = Math.min(minTop, box.top);
        maxRight = Math.max(maxRight, box.right);
        maxBottom = Math.max(maxBottom, box.bottom);
      }
    }
    if (!any) return null;
    return withSize({ left: minLeft, top: minTop, right: maxRight, bottom: maxBottom });
  }

  function reachableAt(el: Element | null): boolean {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    return Boolean(hit && (hit === el || el.contains(hit)));
  }

  function metricsFor(el: Element | null, reachTarget: Element | null): ControlMetrics {
    if (!el) {
      return {
        found: false, box: null, painted: null, escapes: false,
        title: null, ariaLabel: null, text: '', reachable: false,
      };
    }
    const box = boxOf(el.getBoundingClientRect());
    const painted = paintedUnion(el);
    return {
      found: true,
      box,
      painted,
      escapes: Boolean(painted && (painted.right > box.right + 1 || painted.left < box.left - 1)),
      title: el.getAttribute('title'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.textContent ?? '').trim(),
      reachable: reachableAt(reachTarget),
    };
  }

  const query = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
  const footer = query('[data-testid="composer-selector-footer"]');
  const mode = query('[data-testid="composer-selector-mode"]');
  const attachWrapper = query('[data-testid="composer-selector-attach"]');
  const attachButton = query('button[title="Attach files"]');
  const leading = query('[data-testid="composer-selector-leading-controls"]');
  const meterWrapper = query('[data-testid="composer-selector-meter"]');
  const meterButton = query('[data-context-meter]');
  const lead = query('[data-testid="composer-selector-lead"]');
  const workers = query('[data-testid="composer-selector-workers"]');
  const voiceWrapper = query('[data-testid="composer-selector-voice"]');
  const voiceButton = voiceWrapper?.querySelector('button') ?? null;
  const sendWrapper = query('[data-testid="composer-selector-send"]');
  const sendButton = sendWrapper?.querySelector('button') ?? null;

  const controls: Record<string, ControlMetrics> = {
    mode: metricsFor(mode, mode),
    attach: metricsFor(attachWrapper, attachButton),
    leading: metricsFor(leading, null),
    meter: metricsFor(meterWrapper, meterButton),
    lead: metricsFor(lead, lead),
    workers: metricsFor(workers, workers),
    voice: metricsFor(voiceWrapper, voiceButton),
    send: metricsFor(sendWrapper, sendButton),
  };

  const boxOverlaps: string[] = [];
  for (let i = 0; i < KEYS.length; i += 1) {
    for (let j = i + 1; j < KEYS.length; j += 1) {
      const a = controls[KEYS[i]];
      const b = controls[KEYS[j]];
      if (!a.box || !b.box) continue;
      if (overlapArea(a.box, b.box) > 1) boxOverlaps.push(`${KEYS[i]}x${KEYS[j]}`);
    }
  }

  // The chip-vs-chip collision: painted content of one chip reaching into the
  // sibling chip's border box.
  const contentOverlaps: string[] = [];
  if (controls.lead.painted && controls.workers.box && overlapArea(controls.lead.painted, controls.workers.box) > 1) {
    contentOverlaps.push('lead>workers');
  }
  if (controls.workers.painted && controls.lead.box && overlapArea(controls.workers.painted, controls.lead.box) > 1) {
    contentOverlaps.push('workers>lead');
  }

  const escapes = KEYS.filter((key) => controls[key].escapes);

  const footerBox = footer ? boxOf(footer.getBoundingClientRect()) : null;
  const modelCarriers = Array.from(document.querySelectorAll('[title]'))
    .filter((el) => (el.getAttribute('title') ?? '').includes(probe.modelLabel))
    .map((el) => boxOf(el.getBoundingClientRect()));
  const modelReachableViaTitle = Boolean(footerBox) && modelCarriers.some((carrier) => (
    carrier.width > 1
    && carrier.height > 1
    && Boolean(footerBox)
    && overlapArea(carrier, footerBox!) > 1
  ));

  // The lead identity must be VISIBLY painted: measure the actual text ink of
  // the model-label span, clipped by its overflow chain. A zero-width, clipped
  // span (identity present only in textContent/aria-label) measures zero.
  const identitySpan = lead
    ? Array.from(lead.querySelectorAll('span')).find((span) => (span.textContent ?? '').trim() === probe.modelLabel) ?? null
    : null;
  let leadLabelTextWidth = 0;
  if (identitySpan) {
    const range = document.createRange();
    range.selectNodeContents(identitySpan);
    leadLabelTextWidth = range.getBoundingClientRect().width;
  }
  const identityPainted = identitySpan ? paintedUnion(identitySpan) : null;
  const leadIdentityPaintedWidth = identityPainted ? identityPainted.width : 0;

  // Compact-only collapse: the mode shortcut hint disappears and the effort
  // meter stays fully visible. Resolve existing elements on both base and fix.
  const modeHintPainted = Array.from(mode?.querySelectorAll('span') ?? []).find((span) => span.textContent?.trim() === '⇧⇥') ?? null;
  const modeHintUnion = modeHintPainted ? paintedUnion(modeHintPainted) : null;
  const modeHintVisible = Boolean(modeHintUnion && modeHintUnion.width > 1);
  const effortMeter = query('[data-testid="composer-selector-meter-bar"]')?.parentElement ?? null;
  const effortMeterUnion = effortMeter ? paintedUnion(effortMeter) : null;
  const meterPaintedWidth = effortMeterUnion ? effortMeterUnion.width : 0;

  return {
    requestedWidth: footerBox ? footerBox.width : 0,
    footer: footerBox,
    controls,
    boxOverlaps,
    contentOverlaps,
    escapes,
    modelReachableViaTitle,
    leadIdentityPaintedWidth,
    leadLabelPaintedWidth: leadIdentityPaintedWidth,
    leadLabelTextWidth,
    leadLabelFull: leadLabelTextWidth <= 0 ? false : leadIdentityPaintedWidth >= leadLabelTextWidth - 0.5,
    modeHintVisible,
    meterPaintedWidth,
    meterFullWidth: effortMeter?.getBoundingClientRect().width ?? 0,
    effortWordText: (query('[data-testid="composer-selector-effort-word"]')?.textContent ?? '').trim(),
    workersLabelText: (query('[data-testid="composer-selector-workers-label"]')?.textContent ?? '').trim(),
  };
}

// Stubs network endpoints at the fetch boundary. Operator defaults resolve to
// the claude-code runtime (a realistic, longer "Claude Code" Workers label);
// everything else returns an empty payload the callers already tolerate.
const FETCH_STUB_SOURCE = `
(() => {
  window.fetch = (input) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const json = (payload) => Promise.resolve(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    if (url.includes('/api/panel/operator-defaults')) {
      return json({
        values: {
          defaultDispatchRuntime: 'claude-code',
          defaultDispatchModel: '',
          opencodeWorkerModel: null,
          workerStartMode: 'autonomous',
        },
        sources: {},
      });
    }
    return json({});
  };
})();
`;

// Product-accurate specimen environment: the system font stack + the light
// theme tokens the composer consumes, so measured geometry represents the
// product rather than the browser's default serif fallback.
const PRODUCT_ENV_STYLE = `
:root {
  --font-sans-system: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif;
  --t-text: #0f172a;
  --t-text-strong: #020617;
  --t-text-secondary: #475569;
  --t-text-muted: #64748b;
  --t-text-faint: #94a3b8;
  --t-accent: #2563eb;
  --t-accent-soft: rgba(37, 99, 235, 0.08);
  --t-accent-border: rgba(37, 99, 235, 0.26);
  --t-brand-orange: #FF5A1F;
  --t-border: rgba(15, 23, 42, 0.1);
  --t-border-hover: rgba(15, 23, 42, 0.2);
  --t-panel-border: rgba(15, 23, 42, 0.12);
  --t-panel: #FAF9F4;
  --t-panel-solid: #FAF9F4;
  --t-panel-shadow: 0 16px 40px rgba(15, 23, 42, 0.18);
  --t-chat-surface-bg: #F4F2ED;
  --t-chat-surface-input-bg: #FFFFFF;
  --t-divider-subtle: rgba(15, 23, 42, 0.05);
  --t-hover: rgba(15, 23, 42, 0.04);
  --t-bg-card: rgba(15, 23, 42, 0.04);
  --t-input-bg: #FFFFFF;
  --t-input-border: rgba(15, 23, 42, 0.12);
}
body {
  margin: 0;
  font-family: var(--font-sans-system);
  color: var(--t-text);
  background: #F4F2ED;
}
`;

describe.skipIf(!executablePath)('composer selector chip row (real browser path, #2358)', () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let tempDir: string | null = null;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-composer-chips-'));

    // Unrelated persistence + entitlement boundaries: the selector hook reads a
    // stored orchestrator model and the model catalogue reads entitlement.
    // Neither affects chip geometry, so both are reduced to inert stubs.
    fs.writeFileSync(path.join(tempDir, 'orchestrator-store-stub.mjs'), `
export function readStoredOrchestratorModel() { return null; }
export function writeStoredOrchestratorModel() {}
`);
    fs.writeFileSync(path.join(tempDir, 'entitlement-stub.mjs'), `
export function useEntitlement() {
  return {
    plan: 'free',
    flags: {},
    isPro: false,
    isTeam: false,
    founder: null,
    actualPlan: 'free',
    actualFounder: null,
    overrideActive: false,
    loading: false,
  };
}
`);
    fs.writeFileSync(path.join(tempDir, 'server-only-stub.mjs'), 'export default {};\n');

    const entryPath = path.join(tempDir, 'entry.mjs');
    fs.writeFileSync(entryPath, `
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InputButtons } from ${JSON.stringify(inputButtonsPath)};
import { ContextMeter } from ${JSON.stringify(contextMeterPath)};
import { useComposerSelectorState } from ${JSON.stringify(selectorStateHookPath)};

const MODEL_ID = ${JSON.stringify(LONG_MODEL_ID)};
const MODEL_LABEL = ${JSON.stringify(LONG_MODEL_LABEL)};
const RUNTIME_LABEL = ${JSON.stringify(WORKER_RUNTIME_LABEL)};
const THREAD_ID = ${JSON.stringify(THREAD_ID)};
const REPO_LABEL = ${JSON.stringify(REPO_LABEL)};

function ComposerHarness() {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState('multitask');
  const [effort, setEffort] = useState('high');
  const [model, setModel] = useState(MODEL_ID);
  const [backend, setBackend] = useState('codex');
  const selectorControls = useComposerSelectorState({
    enabled: true,
    mode,
    modelId: model,
    modelLabel: MODEL_LABEL,
    backend,
    effort,
    operatorDefaultEffort: 'high',
    adaptiveEnabled: true,
    threadId: THREAD_ID,
    onModeChange: setMode,
    onModelChange: setModel,
    onBackendChange: (nextBackend, nextModel) => { setBackend(nextBackend); if (nextModel) setModel(nextModel); },
    onEffortChange: setEffort,
  });
  return createElement(InputButtons, {
    input,
    enhancing: false,
    preEnhanceInput: null,
    onEnhance: () => {},
    onUndoEnhance: () => {},
    onSubmit: () => {},
    modelLabel: MODEL_LABEL,
    modelId: model,
    onModelChange: setModel,
    activeBackend: backend,
    onBackendChange: (nextBackend, nextModel) => { setBackend(nextBackend); if (nextModel) setModel(nextModel); },
    effort,
    onEffortChange: setEffort,
    adaptiveEnabled: true,
    sessionRulesThreadId: THREAD_ID,
    repoLabel: REPO_LABEL,
    displayMessagesCount: 0,
    composerMode: mode,
    onComposerModeChange: setMode,
    composerSelectorController: selectorControls,
    inlineMeterSlot: createElement(ContextMeter, { tokenCount: 4200, runningTotal: 18400 }),
    voiceModeEnabled: false,
    onVoiceModeChange: () => {},
    composerSelectorV1Enabled: true,
    onRequestTextareaFocus: () => {},
  });
}

window.__o8ComposerHarness = (() => {
  let root = null;
  let host = null;
  return {
    mount(widthPx) {
      if (root) { root.unmount(); root = null; }
      if (host) { host.remove(); host = null; }
      host = document.createElement('div');
      host.id = 'o8-composer-host';
      host.style.width = widthPx + 'px';
      host.style.overflow = 'hidden';
      host.style.borderRadius = '14px';
      host.style.background = 'var(--t-chat-surface-input-bg, #ffffff)';
      document.body.appendChild(host);
      root = createRoot(host);
      root.render(createElement(ComposerHarness));
    },
    setWidth(widthPx) { if (host) host.style.width = widthPx + 'px'; },
    dispose() {
      if (root) { root.unmount(); root = null; }
      if (host) { host.remove(); host = null; }
    },
  };
})();
`);

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
      name: 'o8-composer-chip-alias',
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/orchestrator\/store$/ }, () => ({
          path: path.join(tempDir!, 'orchestrator-store-stub.mjs'),
        }));
        builder.onResolve({ filter: /^@\/lib\/entitlement\/context$/ }, () => ({
          path: path.join(tempDir!, 'entitlement-stub.mjs'),
        }));
        builder.onResolve({ filter: /^server-only$/ }, () => ({
          path: path.join(tempDir!, 'server-only-stub.mjs'),
        }));
        builder.onResolve({ filter: /^@\/.+/ }, (args) => ({
          path: resolveSrcFile(args.path.slice(2)),
        }));
      },
    };

    const bundlePath = path.join(tempDir, 'composer-chips.bundle.js');
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
      nodePaths: [path.join(repoRoot, 'node_modules')],
      legalComments: 'none',
      logLevel: 'silent',
    });
    const bundleCode = fs.readFileSync(bundlePath, 'utf8');

    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${PRODUCT_ENV_STYLE}</style></head><body></body></html>`);
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

  async function settleLayout(): Promise<void> {
    if (!page) throw new Error('browser page was not initialized');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
  }

  async function maybeCaptureProof(label: string): Promise<void> {
    if (!proofDir || !page) return;
    fs.mkdirSync(proofDir, { recursive: true });
    await page.locator('#o8-composer-host').screenshot({ path: path.join(proofDir, `${label}.png`) });
  }

  async function mountAndMeasure(widthPx: number): Promise<ComposerMetrics> {
    if (!page) throw new Error('browser page was not initialized');
    await page.evaluate((width) => {
      const harness = (window as unknown as {
        __o8ComposerHarness: { mount: (value: number) => void; setWidth: (value: number) => void };
      }).__o8ComposerHarness;
      harness.mount(width);
    }, widthPx);
    // Wait for the fetched operator default (claude-code) to reach the Workers
    // chip, so the measured runtime label is the real, longer one.
    await page.waitForFunction((runtimeLabel) => {
      const label = document.querySelector('[data-testid="composer-selector-workers-label"]');
      return Boolean(document.querySelector('[data-testid="composer-selector-lead"]'))
        && Boolean(document.querySelector('[data-testid="composer-selector-workers"]'))
        && Boolean(document.querySelector('[data-testid="composer-selector-send"] button'))
        && Boolean(label && (label.textContent ?? '').includes(runtimeLabel));
    }, WORKER_RUNTIME_LABEL, { timeout: 20_000 });
    await settleLayout();
    return await page.evaluate(
      measureComposerInPage,
      { modelLabel: LONG_MODEL_LABEL },
    ) as unknown as ComposerMetrics;
  }

  async function resizeTo(widthPx: number): Promise<ComposerMetrics> {
    if (!page) throw new Error('browser page was not initialized');
    await page.evaluate((width) => {
      const harness = (window as unknown as {
        __o8ComposerHarness: { mount: (value: number) => void; setWidth: (value: number) => void };
      }).__o8ComposerHarness;
      harness.setWidth(width);
    }, widthPx);
    await page.waitForFunction(
      (width) => Math.abs(document.getElementById('o8-composer-host')!.getBoundingClientRect().width - width) <= 2,
      widthPx,
      { timeout: 5_000 },
    );
    await settleLayout();
    return await page.evaluate(
      measureComposerInPage,
      { modelLabel: LONG_MODEL_LABEL },
    ) as unknown as ComposerMetrics;
  }

  function control(metrics: ComposerMetrics, key: string): ControlMetrics {
    const entry = metrics.controls[key];
    expect(entry, `${key} control was not measured`).toBeTruthy();
    return entry;
  }

  function assertRealComposer(metrics: ComposerMetrics, expectedWidthPx: number): void {
    expect(metrics.footer, 'composer footer did not render').not.toBeNull();
    expect(
      metrics.footer!.width,
      'composer footer did not lay out at the requested width',
    ).toBeGreaterThanOrEqual(expectedWidthPx - 2);
    expect(metrics.footer!.width, 'composer footer diverged from the requested width').toBeLessThanOrEqual(expectedWidthPx + 2);
  }

  // Presence + reachability: a control that is hidden, collapsed to zero width,
  // or clipped off the composer edge cannot be clicked and must not green-pass.
  function assertControlsReachable(metrics: ComposerMetrics): void {
    for (const key of REQUIRED_CONTROLS) {
      const entry = control(metrics, key);
      expect(entry.found, `${key} control is missing`).toBe(true);
      expect(entry.box, `${key} control has no layout box`).not.toBeNull();
      expect(entry.box!.width, `${key} control has zero/near-zero width (hidden false green)`).toBeGreaterThan(1);
      expect(entry.box!.height, `${key} control has zero/near-zero height`).toBeGreaterThan(1);
      expect(entry.reachable, `${key} control center is not hit-testable (clipped or covered)`).toBe(true);
    }
  }

  function assertContainedInComposer(metrics: ComposerMetrics): void {
    const footer = metrics.footer!;
    for (const key of CONTROL_KEYS) {
      const entry = metrics.controls[key];
      if (!entry.found || !entry.box) continue;
      expect(entry.box.left, `${key} control paints left of the composer`).toBeGreaterThanOrEqual(footer.left - 1);
      expect(entry.box.right, `${key} control escapes the composer's right edge`).toBeLessThanOrEqual(footer.right + 1);
    }
  }

  function assertNoChipCollision(metrics: ComposerMetrics): void {
    expect(
      metrics.escapes,
      'chip content paints outside its own box (overlaps the neighboring chip)',
    ).toEqual([]);
    expect(
      metrics.contentOverlaps,
      'a chip paints into its sibling chip',
    ).toEqual([]);
    expect(
      metrics.boxOverlaps,
      'composer controls overlap each other',
    ).toEqual([]);
  }

  // Accessible identity + reachable full value survive at every width, and the
  // lead model identity stays VISIBLY painted (not merely present in textContent
  // or aria-label). Effort/Workers labels may collapse at narrow widths.
  function assertAccessibleIdentity(metrics: ComposerMetrics): void {
    const lead = control(metrics, 'lead');
    const workers = control(metrics, 'workers');
    const mode = control(metrics, 'mode');

    expect(lead.ariaLabel ?? '', 'Lead chip lost its accessible name').toContain('Lead:');
    expect(lead.ariaLabel ?? '', 'Lead chip accessible name dropped the model identity').toContain(LONG_MODEL_LABEL);
    expect(lead.ariaLabel ?? '', 'Lead chip accessible name dropped the effort').toContain('High');
    expect(lead.title ?? '', 'full lead model value is not reachable via the chip tooltip').toContain(LONG_MODEL_LABEL);
    expect(metrics.modelReachableViaTitle, 'no hoverable tooltip carrier exposes the full lead model value').toBe(true);
    expect(
      metrics.leadIdentityPaintedWidth,
      'lead model identity is not a meaningful visible prefix (need ~40px at narrow widths)',
    ).toBeGreaterThanOrEqual(40 - 0.5);

    expect(workers.ariaLabel ?? '', 'Workers chip lost its accessible name').toContain('Workers:');
    expect(workers.ariaLabel ?? '', 'Workers chip accessible name dropped the runtime').toContain(WORKER_RUNTIME_LABEL);
    expect(workers.title ?? '', 'Workers chip tooltip dropped the runtime').toContain(WORKER_RUNTIME_LABEL);

    expect(mode.ariaLabel ?? '', 'Mode chip lost its accessible name').toContain('Mode:');
  }

  // Narrow width: the decorative shortcut hint and the text labels collapse, but
  // the model identity and a meaningful effort meter remain.
  function assertCompactCollapse(metrics: ComposerMetrics): void {
    expect(metrics.modeHintVisible, 'mode Shift+Tab hint did not collapse at narrow width').toBe(false);
    expect(metrics.meterPaintedWidth, 'effort meter is partially clipped at narrow width').toBeGreaterThanOrEqual(metrics.meterFullWidth - 0.5);
  }

  // Roomy width: the visible labels + hint are fully present, not collapsed.
  function assertRoomVisibleLabels(metrics: ComposerMetrics): void {
    expect(metrics.leadLabelFull, 'roomy lead model label is truncated despite available width').toBe(true);
    expect(metrics.workersLabelText, 'roomy Workers label does not carry the runtime').toContain(WORKER_RUNTIME_LABEL);
    expect(metrics.effortWordText, 'roomy effort label rendered with no visible text').not.toBe('');
    expect(metrics.modeHintVisible, 'roomy mode Shift+Tab hint did not restore').toBe(true);
    expect(metrics.meterPaintedWidth, 'roomy effort meter is not fully visible').toBeGreaterThanOrEqual(14);
  }

  it('keeps the Multitask chip row collision-free at ~380px', async () => {
    const metrics = await mountAndMeasure(NARROW_COMPOSER_WIDTH_PX);
    await maybeCaptureProof('narrow-380');
    assertRealComposer(metrics, NARROW_COMPOSER_WIDTH_PX);
    assertControlsReachable(metrics);
    assertContainedInComposer(metrics);
    assertAccessibleIdentity(metrics);
    assertCompactCollapse(metrics);
    assertNoChipCollision(metrics);
  });

  it('keeps the Multitask chip row collision-free at the narrower nearby width', async () => {
    const metrics = await mountAndMeasure(NARROWER_COMPOSER_WIDTH_PX);
    await maybeCaptureProof('narrow-340');
    assertRealComposer(metrics, NARROWER_COMPOSER_WIDTH_PX);
    assertControlsReachable(metrics);
    assertContainedInComposer(metrics);
    assertAccessibleIdentity(metrics);
    assertCompactCollapse(metrics);
    assertNoChipCollision(metrics);
  });

  it('renders the roomy control fully with the same invariants', async () => {
    const metrics = await mountAndMeasure(ROOMY_COMPOSER_WIDTH_PX);
    await maybeCaptureProof('roomy-900');
    assertRealComposer(metrics, ROOMY_COMPOSER_WIDTH_PX);
    assertControlsReachable(metrics);
    assertContainedInComposer(metrics);
    assertAccessibleIdentity(metrics);
    assertRoomVisibleLabels(metrics);
    assertNoChipCollision(metrics);
  });

  it('restores the roomy chip layout after a narrow resize', async () => {
    const roomy = await mountAndMeasure(ROOMY_COMPOSER_WIDTH_PX);
    await maybeCaptureProof('resize-roomy-900');
    assertAccessibleIdentity(roomy);
    assertRoomVisibleLabels(roomy);

    const narrow = await resizeTo(NARROW_COMPOSER_WIDTH_PX);
    await maybeCaptureProof('resize-narrow-380');
    assertRealComposer(narrow, NARROW_COMPOSER_WIDTH_PX);
    assertControlsReachable(narrow);
    assertAccessibleIdentity(narrow);
    assertCompactCollapse(narrow);

    const restored = await resizeTo(ROOMY_COMPOSER_WIDTH_PX);
    await maybeCaptureProof('resize-restored-900');
    assertRealComposer(restored, ROOMY_COMPOSER_WIDTH_PX);
    assertControlsReachable(restored);
    assertAccessibleIdentity(restored);
    assertRoomVisibleLabels(restored);
    assertNoChipCollision(restored);
  });
});
