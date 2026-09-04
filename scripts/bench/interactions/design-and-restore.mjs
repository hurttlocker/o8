// Design Mode and persisted-state relaunch measurements. These scenarios share
// browser-pane state and must remain ordered: Design Mode establishes the
// browser pane, then relaunch checks the four named persisted facets.
import { sleep } from '../terminal-workload/runtime.mjs';
import {
  instrumentationInitScript,
  observeDesignHover,
  observePaintedCondition,
  readBootPhases,
  snapshotOverlayLabels,
} from './page-instrumentation.mjs';

const DESIGN_BUTTON_SELECTOR = 'button[title*="Design Mode"]';
const DESIGN_COMPOSER_SELECTOR = '[data-design-composer]';
const DRAW_SURFACE_SELECTOR = '[data-o8-draw-surface]';

function unavailableSample(label, error) {
  return { durationMs: null, note: `${label} failed: ${error instanceof Error ? error.message : String(error)}` };
}

export async function measureDesignMode(page, fixtureUrl, targetBlockId, timeoutMs) {
  const unavailable = (note) => ({
    design_arm_ms: { durationMs: null, note },
    design_hover_ms: { durationMs: null, note },
    design_select_ms: { durationMs: null, note },
    design_prompt_ready_ms: { durationMs: null, note },
  });
  try {
    const panelAlreadyOpen = await page.locator('[aria-label="Close panel"]').count() > 0;
    if (!panelAlreadyOpen) {
      const panelButton = page.locator('[aria-label="Open O8 panel"]').first();
      if (await panelButton.count() > 0) await panelButton.click({ timeout: 5_000 }).catch(() => undefined);
      await sleep(1_200);
    }
    const openBrowserPane = async () => {
      await page.evaluate((url) => {
        window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url } }));
      }, fixtureUrl);
      try {
        await page.locator(DRAW_SURFACE_SELECTOR).first().waitFor({ state: 'visible', timeout: Math.min(45_000, timeoutMs) });
        return true;
      } catch {
        return false;
      }
    };
    if (!await openBrowserPane()) {
      const panelToggle = page.locator('[aria-label="Close panel"], [aria-label="Open O8 panel"]').first();
      if (await panelToggle.count() > 0) await panelToggle.click({ timeout: 5_000 }).catch(() => undefined);
      await sleep(1_200);
      if (!await openBrowserPane()) {
        return unavailable('the embedded browser pane did not mount after two open-browser requests and a panel toggle');
      }
    }
    const designButton = page.locator(DESIGN_BUTTON_SELECTOR).first();
    if (await designButton.count() === 0) return unavailable('no Design Mode control rendered in the browser pane');

    const armPending = page.evaluate(observePaintedCondition, {
      selector: 'button[aria-pressed="true"][title*="Design Mode"]',
      timeoutMs,
      requireFocusInside: false,
    }).catch((error) => unavailableSample('Design Mode arm observation', error));
    await page.evaluate(() => true);
    await designButton.click({ timeout: 5_000 });
    const arm = await armPending;
    if (!Number.isFinite(arm.durationMs)) {
      return { ...unavailable('Design Mode never reported an armed state'), design_arm_ms: arm };
    }

    const rect = await page.evaluate((selector) => {
      const surface = document.querySelector(selector);
      const box = surface?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    }, DRAW_SURFACE_SELECTOR);
    if (!rect || rect.width < 60 || rect.height < 60) {
      return { ...unavailable('the draw surface has no usable geometry'), design_arm_ms: arm };
    }

    let fixtureLoaded = false;
    try {
      await page.waitForFunction(({ surfaceSelector, blockId }) => {
        const frame = document.querySelector(`${surfaceSelector} iframe`);
        const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
        return Boolean(doc?.getElementById(blockId));
      }, { surfaceSelector: DRAW_SURFACE_SELECTOR, blockId: targetBlockId }, { timeout: 20_000 });
      fixtureLoaded = true;
    } catch { fixtureLoaded = false; }
    const blockPoint = fixtureLoaded ? await page.evaluate(({ surfaceSelector, blockId }) => {
      const frame = document.querySelector(`${surfaceSelector} iframe`);
      const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null;
      const block = doc?.getElementById(blockId);
      if (!frame || !block) return null;
      const frameBox = frame.getBoundingClientRect();
      const blockBox = block.getBoundingClientRect();
      return {
        x: frameBox.x + blockBox.x + blockBox.width / 2,
        y: frameBox.y + blockBox.y + blockBox.height / 2,
      };
    }, { surfaceSelector: DRAW_SURFACE_SELECTOR, blockId: targetBlockId }) : null;
    if (!blockPoint) {
      return {
        ...unavailable(`the Design Mode fixture page (#${targetBlockId}) never loaded inside the browser pane, so there was no element to hover, select, or prompt on`),
        design_arm_ms: arm,
      };
    }

    await page.mouse.move(Math.max(4, rect.x - 120), rect.y + 12);
    await sleep(250);
    const before = await page.evaluate(snapshotOverlayLabels);
    const hoverPending = page.evaluate(observeDesignHover, { before, timeoutMs: 6_000 })
      .catch((error) => unavailableSample('Design Mode hover observation', error));
    await page.evaluate(() => true);
    await page.mouse.move(blockPoint.x, blockPoint.y, { steps: 12 });
    await page.mouse.move(blockPoint.x + 24, blockPoint.y + 18, { steps: 6 });
    const hover = await hoverPending;

    const selectPending = page.evaluate(observePaintedCondition, {
      selector: DESIGN_COMPOSER_SELECTOR,
      timeoutMs,
      requireFocusInside: false,
    }).catch((error) => unavailableSample('Design Mode selection observation', error));
    const promptPending = page.evaluate(observePaintedCondition, {
      selector: DESIGN_COMPOSER_SELECTOR,
      timeoutMs,
      requireFocusInside: true,
    }).catch((error) => unavailableSample('Design Mode prompt observation', error));
    await page.evaluate(() => true);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(blockPoint.x + step * 9, blockPoint.y + step * 6);
    }
    await page.mouse.up();
    const select = await selectPending;
    const promptReady = await promptPending;
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(300);
    return {
      design_arm_ms: arm,
      design_hover_ms: hover,
      design_select_ms: select,
      design_prompt_ready_ms: promptReady,
    };
  } catch (error) {
    return unavailable(`Design Mode sequence failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const RESTORE_FACETS = Object.freeze({
  terminal: '[data-o8-workspace-tab="fixture-terminal"]',
  agent: '[data-o8-workspace-tab="fixture-agent"]',
  canvas: '[data-o8-workspace-tab="fixture-canvas"]',
  browser: '[data-o8-browser="panel"]',
});

async function facetEstablished(page, selector) {
  return page.locator(selector).count().then((count) => count > 0).catch(() => false);
}

export async function measureWarmRelaunch(context, page, baseUrl, timeoutMs, bootSampleFrom) {
  const established = Object.fromEntries(await Promise.all(Object.entries(RESTORE_FACETS).map(async ([name, selector]) => (
    [name, await facetEstablished(page, selector)]
  ))));
  await Promise.race([
    page.close().catch(() => undefined),
    sleep(5_000),
  ]);
  const relaunched = await context.newPage();
  await relaunched.addInitScript(instrumentationInitScript, { injectedDelayMs: 0 });
  const response = await relaunched.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  if (!response?.ok()) {
    const reason = `/dashboard returned ${response?.status() ?? 'no response'} on relaunch`;
    return {
      page: relaunched,
      facets: Object.fromEntries(Object.keys(RESTORE_FACETS).map((name) => [name, {
        established: established[name], restored: false, readyMs: null, reason,
      }])),
      sample: { durationMs: null, note: reason },
    };
  }
  try {
    await relaunched.waitForFunction(() => globalThis.__o8Interactions?.hydratedAtMs !== null, undefined, { timeout: timeoutMs });
  } catch {
    const reason = `relaunched dashboard did not hydrate within ${timeoutMs}ms`;
    return {
      page: relaunched,
      facets: Object.fromEntries(Object.keys(RESTORE_FACETS).map((name) => [name, {
        established: established[name], restored: false, readyMs: null, reason,
      }])),
      sample: { durationMs: null, note: reason },
    };
  }

  const facets = {};
  for (const [name, selector] of Object.entries(RESTORE_FACETS)) {
    if (!established[name]) {
      facets[name] = {
        established: false,
        restored: false,
        readyMs: null,
        reason: `${name} state was not established before relaunch`,
      };
      continue;
    }
    const started = Date.now();
    try {
      await relaunched.locator(selector).first().waitFor({ state: 'attached', timeout: 20_000 });
      facets[name] = { established: true, restored: true, readyMs: Date.now() - started, reason: null };
    } catch {
      facets[name] = {
        established: true,
        restored: false,
        readyMs: null,
        reason: `${selector} did not reappear within 20000ms`,
      };
    }
  }
  const sample = bootSampleFrom(await relaunched.evaluate(readBootPhases));
  const missing = Object.entries(facets).filter(([, facet]) => !facet.restored).map(([name]) => name);
  return {
    page: relaunched,
    facets,
    sample: Number.isFinite(sample.durationMs)
      ? { ...sample, note: missing.length > 0 ? `warm restore missing: ${missing.join(', ')}` : null }
      : sample,
  };
}
