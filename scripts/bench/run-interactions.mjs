#!/usr/bin/env node
// Interaction-performance harness (#1697). Generates deterministic scale
// fixtures, boots an isolated stack against them, samples operator-visible
// interaction latency with phase attribution, proves it can still fail by
// injecting a render delay, then verifies it left nothing behind.
//
// See docs/operations/interaction-performance-budgets.md for the budget
// manifest and tests/bench/README.md for the command surface.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBrowserPath, targetFromPanelStatus } from './measure-browser-boot.mjs';
import { sleep } from './terminal-workload/runtime.mjs';
import {
  buildFixturePlan,
  fixtureRepoName,
  materializeFixture,
} from './interactions/fixtures.mjs';
import { startFixturePageServer } from './interactions/fixture-server.mjs';
import { startTargetStack } from './interactions/targets.mjs';
import { readTerminalWorkloadComposition } from './interactions/composed.mjs';
import { measureDesignMode, measureWarmRelaunch } from './interactions/design-and-restore.mjs';
import { closeMeasuredBrowser, launchMeasuredBrowser } from './interactions/browser-runtime.mjs';
import { scenarioResult } from './interactions/statistics.mjs';
import { runSoak } from './interactions/soak.mjs';
import {
  INTERACTION_BUDGETS,
  checkReceiptValidity,
  evaluateInteractionBudgets,
} from './interactions/budgets.mjs';
import {
  addOwnedProcessRoot,
  captureOwnedProcessTree,
  captureOwnedProcessTreeSafe,
  createOwnedProcessInventory,
  killTmuxSessions,
  listTmuxSessions,
  listWorktrees,
  ownedTmuxSessions,
  terminateAndWaitOwnedProcesses,
  verifyCleanup,
} from './interactions/cleanup.mjs';
import {
  baselineFromReceipt,
  benchmarkIdentity,
  contentionSnapshot,
  deriveRunStatus,
  hostProfile,
  interactionConfig,
  printSummary,
  readBaseline,
  writeReceipt,
} from './interactions/receipt.mjs';
import {
  instrumentationInitScript,
  measureRepoInventory,
  observeActiveContextReveal,
  observeComposerKeystroke,
  observeFleetReveal,
  observeTabSwitch,
  readBootPhases,
} from './interactions/page-instrumentation.mjs';

const ROOT = process.cwd();
const SCHEMA = 'o8/interaction-performance/v1';
const COMPOSER_SELECTOR = 'textarea[data-o8-active-composer="true"]';
const FIXTURE_REPO_PATTERN = 'o8-fixture-repo-\\d{4}';
const PHASE_NAMES = ['serverWaitMs', 'inputDelayMs', 'mainThreadMs', 'reactCommitMs', 'presentationMs'];
const DATA_PHASE_NAMES = ['serverWaitMs', 'transferMs', 'mainThreadMs', 'reactCommitMs', 'presentationMs'];

async function readTarget(baseUrl, token) {
  try {
    const response = await fetch(`${baseUrl}/api/panel/status`, {
      cache: 'no-store',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { appVersion: null, buildGitSha: null, buildMode: null, platform: null, unavailableReason: `/api/panel/status returned ${response.status}` };
    }
    return targetFromPanelStatus(await response.json());
  } catch (error) {
    return {
      appVersion: null,
      buildGitSha: null,
      buildMode: null,
      platform: null,
      unavailableReason: `/api/panel/status failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function openInstrumentedPage(browser, baseUrl, { injectedDelayMs = 0, bootTimeoutMs }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && consoleErrors.length < 50) consoleErrors.push(message.text());
  });
  await page.addInitScript(instrumentationInitScript, { injectedDelayMs });
  let response;
  try {
    response = await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: bootTimeoutMs });
  } catch (error) {
    return {
      context,
      page,
      consoleErrors,
      unavailableReason: `dashboard navigation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response?.ok()) {
    return { context, page, consoleErrors, unavailableReason: `/dashboard returned ${response?.status() ?? 'no response'}` };
  }
  let unavailableReason = null;
  try {
    await page.waitForFunction(() => globalThis.__o8Interactions?.hydratedAtMs !== null, undefined, { timeout: bootTimeoutMs });
  } catch {
    unavailableReason = `dashboard did not report hydration within ${bootTimeoutMs}ms`;
  }
  return { context, page, consoleErrors, unavailableReason };
}

function unavailableObservation(label, error) {
  return {
    durationMs: null,
    note: `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

// Time from the hydration boundary until a composer will accept input. This is
// measured in page time, not wall-clock around a protocol round trip.

// The fleet reveal: the operator clicks Projects and the generated repositories
// paint in the left panel. This is the rendered entry point the scale fixtures
// exist for; the inventory request timing below is the data half of the same
// story, not a substitute for it.
async function measureFleetReveal(page, expectedCount, timeoutMs) {
  const projects = page.getByRole('button', { name: 'Projects' }).first();
  try {
    // Wait for the control to exist before measuring. Shell readiness is its
    // own metric; the reveal is measured from the click, not from boot.
    await projects.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return { durationMs: null, note: `no Projects disclosure rendered in the left panel within ${timeoutMs}ms` };
  }
  const countRows = () => page.evaluate((pattern) => (
    (document.querySelector('[data-o8-agent-panel="true"]')?.textContent?.match(new RegExp(pattern, 'g')) ?? []).length
  ), FIXTURE_REPO_PATTERN).catch(() => 0);
  // The control is a toggle. Establish the closed state outside the measured
  // window so a default-open disclosure cannot turn the benchmark click into
  // a close, and wait for the close to paint before installing the observer.
  if (await countRows() >= expectedCount) {
    await projects.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForFunction(({ pattern, count }) => (
      (document.querySelector('[data-o8-agent-panel="true"]')?.textContent?.match(new RegExp(pattern, 'g')) ?? []).length < count
    ), { pattern: FIXTURE_REPO_PATTERN, count: expectedCount }, { timeout: Math.min(10_000, timeoutMs) }).catch(() => undefined);
  }
  const attemptTimeoutMs = Math.min(20_000, timeoutMs);
  const pending = page.evaluate(observeFleetReveal, {
    expectedCount,
    repoPattern: `${FIXTURE_REPO_PATTERN}`,
    timeoutMs: attemptTimeoutMs,
  }).catch((error) => unavailableObservation('fleet reveal observation', error));
  try {
    await page.evaluate(() => true);
    await projects.click({ timeout: 10_000 });
  } catch (error) {
    await pending;
    return unavailableObservation('fleet reveal interaction', error);
  }
  return pending;
}

async function measureActiveContextReveal(page, repoName, timeoutMs) {
  // The rows carry an app-authored accessible name, so the harness clicks the
  // row the operator would click rather than matching on layout or text.
  const row = page.locator(`[aria-label="${repoName} repository"]`).first();
  if (await row.count() === 0) {
    return { durationMs: null, note: `no left-panel row labelled "${repoName} repository"; the fleet reveal did not paint it` };
  }
  const pending = page.evaluate(observeActiveContextReveal, { repoName, timeoutMs })
    .catch((error) => unavailableObservation('active-context observation', error));
  try {
    await page.evaluate(() => true);
    await row.click({ timeout: 10_000 });
  } catch (error) {
    await pending;
    return unavailableObservation('active-context interaction', error);
  }
  return pending;
}

function bootSampleFrom(boot) {
  if (!boot || !Number.isFinite(boot.hydratedAtMs)) {
    return { durationMs: null, note: 'the dashboard never stamped its hydration boundary' };
  }
  return {
    durationMs: Number(boot.hydratedAtMs.toFixed(2)),
    phases: {
      serverWaitMs: Number.isFinite(boot.serverWaitMs) ? { value: boot.serverWaitMs } : { value: null, note: 'Navigation Timing unavailable' },
      inputDelayMs: { value: null, note: 'boot is not an input-driven interaction' },
      mainThreadMs: Number.isFinite(boot.mainThreadMs) ? { value: boot.mainThreadMs } : { value: null, note: 'the browser does not expose longtask entries' },
      reactCommitMs: { value: null, note: 'React commit is not separately exposed by the platform; it is inside mainThreadMs' },
      presentationMs: Number.isFinite(boot.firstContentfulPaintMs) ? { value: boot.firstContentfulPaintMs } : { value: null, note: 'first-contentful-paint entry unavailable' },
    },
  };
}

async function waitForComposer(page, timeoutMs) {
  try {
    await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return { durationMs: null, note: `no ${COMPOSER_SELECTOR} became visible within ${timeoutMs}ms` };
  }
  const durationMs = await page.evaluate(() => {
    const hydratedAtMs = globalThis.__o8Interactions?.hydratedAtMs;
    return Number.isFinite(hydratedAtMs) ? Number((performance.now() - hydratedAtMs).toFixed(2)) : null;
  }).catch(() => null);
  return Number.isFinite(durationMs)
    ? { durationMs, phases: {} }
    : { durationMs: null, note: 'hydration boundary was never stamped, so first-interaction time has no origin' };
}

async function sampleKeystrokes(page, samples) {
  const results = [];
  for (let index = 0; index < samples; index += 1) {
    const focused = await page.locator(COMPOSER_SELECTOR).first().focus().then(() => true).catch(() => false);
    if (!focused) {
      results.push({ durationMs: null, note: 'no active composer to focus' });
      continue;
    }
    const pending = page.evaluate(observeComposerKeystroke, COMPOSER_SELECTOR)
      .catch((error) => unavailableObservation('composer keystroke observation', error));
    // Round-trip so the observer is installed before the trusted key press.
    try {
      await page.evaluate(() => true);
      await page.keyboard.press('o');
    } catch (error) {
      await pending;
      results.push(unavailableObservation('composer keystroke interaction', error));
      continue;
    }
    results.push(await pending);
    await page.keyboard.press('Backspace').catch(() => undefined);
    await sleep(60);
  }
  return results;
}

async function sampleTabSwitches(page, tabIds, samples) {
  const results = [];
  if (tabIds.length < 2) {
    return [{
      durationMs: null,
      note: `tab switching needs two workspace tab pills, found ${tabIds.length}; terminal tab/pane switching under load is covered by the composed terminal-workload lane (rapid-switch at N=12)`,
    }];
  }
  for (let index = 0; index < samples; index += 1) {
    // Always switch AWAY from whatever is active. Alternating blindly through
    // the pill list clicks the already-active tab half the time, which is not a
    // switch and cannot be timed.
    const activeTabId = await page.evaluate(() => globalThis.__o8Interactions?.activeTabId ?? null).catch(() => null);
    const targetTabId = tabIds.find((tabId) => tabId !== activeTabId) ?? tabIds[index % tabIds.length];
    const locator = page.locator(`[data-o8-workspace-tab="${targetTabId}"]`).first();
    if (await locator.count() === 0) {
      results.push({ durationMs: null, note: `workspace tab ${targetTabId} is not rendered` });
      continue;
    }
    const pending = page.evaluate(observeTabSwitch, targetTabId)
      .catch((error) => unavailableObservation('tab-switch observation', error));
    // Click the label end of the pill. The centre of a crowded pill is where
    // the close affordance sits, and closing a tab is not switching to it.
    try {
      await page.evaluate(() => true);
      await locator.click({ timeout: 5_000, position: { x: 10, y: 13 } });
    } catch (error) {
      await pending;
      results.push(unavailableObservation('tab-switch interaction', error));
      continue;
    }
    results.push(await pending);
    await sleep(80);
  }
  return results;
}

async function sampleRepoInventory(page, samples, timeoutMs) {
  const results = [];
  for (let index = 0; index < samples; index += 1) {
    const pending = page.evaluate(measureRepoInventory, { timeoutMs })
      .catch((error) => unavailableObservation('repository inventory observation', error));
    const sample = await Promise.race([
      pending,
      sleep(timeoutMs + 250).then(() => ({
        durationMs: timeoutMs,
        censoredLowerBound: true,
        repoCount: null,
        note: `/api/panel/repos exceeded the independent ${timeoutMs}ms harness bound; recorded as a >=${timeoutMs}ms budget failure`,
        phases: {
          serverWaitMs: { value: timeoutMs, note: 'lower bound: request did not complete' },
          transferMs: { value: null, note: 'request did not complete' },
          mainThreadMs: { value: null, note: 'response was not available to parse' },
          reactCommitMs: { value: null, note: 'this probe measures the data path only; no React commit participates' },
          presentationMs: { value: null, note: 'this probe measures the data path only; nothing is painted' },
        },
      })),
    ]);
    results.push(sample);
    if (sample.censoredLowerBound) break;
    await sleep(40);
  }
  return results;
}

async function closeContextBounded(context, timeoutMs = 5_000) {
  return Promise.race([
    context.close().then(() => false).catch(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
}

async function measureScale({ browser, browserPid, scale, runConfig }) {
  const plan = buildFixturePlan(scale, runConfig.seed);
  const fixture = materializeFixture(plan);
  const runTag = `${runConfig.runTag}-scale-${scale}`;
  const ownedInventory = createOwnedProcessInventory(runTag);
  const tmuxSessionsBefore = listTmuxSessions();
  const worktreesBefore = listWorktrees(fixture.repoDir);
  const contentionBefore = contentionSnapshot();
  let stack = null;
  let context = null;
  let fixturePage = null;
  let inventoryTimer = null;
  let contextCloseTimedOut = false;
  const startedAt = Date.now();
  try {
    fixturePage = await startFixturePageServer(runConfig.seed, { runTag });
    addOwnedProcessRoot(ownedInventory, fixturePage.pid, 'fixture-server');
    stack = await startTargetStack(ROOT, fixture, runConfig.target, runConfig.requestedBuildMode, {
      runTag,
      archiveSha256: runConfig.archiveSha256,
      releaseGitSha: runConfig.releaseGitSha,
      timeoutMs: runConfig.bootTimeoutMs,
    });
    addOwnedProcessRoot(ownedInventory, stack.nextPid, 'application-launcher');
    addOwnedProcessRoot(ownedInventory, stack.wsPid, 'websocket-server');
    inventoryTimer = setInterval(() => captureOwnedProcessTreeSafe(ownedInventory), 1_000);
    inventoryTimer.unref();
    const baseUrl = `http://127.0.0.1:${stack.apiPort}`;
    const reportedTarget = await readTarget(baseUrl, stack.token);
    const target = {
      ...reportedTarget,
      serverReportedBuildGitSha: reportedTarget.buildGitSha,
      buildGitSha: stack.releaseArtifact?.releaseGitSha ?? reportedTarget.buildGitSha,
      buildGitShaSource: stack.releaseArtifact?.releaseGitSha ? 'explicit-release-provenance' : 'server-reported',
      reportedBuildMode: reportedTarget.buildMode,
      buildMode: stack.buildMode,
      artifactTargetDigestSha256: stack.releaseArtifact?.targetDigestSha256 ?? null,
      runtimeIdentityNote: reportedTarget.unavailableReason,
      unavailableReason: null,
    };
    const opened = await openInstrumentedPage(browser, baseUrl, { bootTimeoutMs: runConfig.bootTimeoutMs });
    context = opened.context;
    let page = opened.page;
    const blocked = opened.unavailableReason;

    const coldBoot = blocked ? [] : [bootSampleFrom(await page.evaluate(readBootPhases))];
    // Order is part of the measurement contract. The operator's first act after
    // the shell paints is to open the fleet, so the reveal is measured cold,
    // before anything else warms the repository path. Reordering these steps
    // changes the numbers, so the sequence is fixed and documented.
    const fleetReveal = blocked
      ? { durationMs: null, note: blocked }
      : await measureFleetReveal(page, scale, runConfig.revealTimeoutMs);
    // Start observing composer readiness before the repository click. The
    // active-context label may be absent and consume its full bound even when
    // the click has already made the composer usable; awaiting sequentially
    // would falsely add that label timeout to first-input readiness.
    const composerPending = blocked
      ? Promise.resolve({ durationMs: null, note: blocked })
      : waitForComposer(page, runConfig.composerTimeoutMs);
    const activeContext = blocked
      ? { durationMs: null, note: blocked }
      : await measureActiveContextReveal(page, fixtureRepoName(scale), runConfig.revealTimeoutMs);
    const composerReady = await composerPending;
    const keystrokes = blocked ? [] : await sampleKeystrokes(page, runConfig.samples);
    const tabIds = blocked ? [] : await page.evaluate(() => (
      Array.from(document.querySelectorAll('[data-o8-workspace-tab]')).map((element) => element.getAttribute('data-o8-workspace-tab'))
    ));
    const tabSwitches = blocked ? [] : await sampleTabSwitches(page, tabIds.filter(Boolean), runConfig.samples);
    const design = blocked
      ? {
        design_arm_ms: { durationMs: null, note: blocked },
        design_hover_ms: { durationMs: null, note: blocked },
        design_select_ms: { durationMs: null, note: blocked },
        design_prompt_ready_ms: { durationMs: null, note: blocked },
      }
      : await measureDesignMode(page, fixturePage.url, fixturePage.targetBlockId, runConfig.bootTimeoutMs);
    const soak = blocked
      ? { unavailableReason: blocked }
      : await runSoak(page, stack, browserPid, runConfig.soakMs);

    let warmRelaunch = { durationMs: null, note: blocked ?? 'warm relaunch not attempted' };
    let restoredState = null;
    let inventory = [];
    if (!blocked) {
      const relaunch = await measureWarmRelaunch(context, page, baseUrl, runConfig.bootTimeoutMs, bootSampleFrom);
      page = relaunch.page;
      warmRelaunch = relaunch.sample;
      restoredState = relaunch.facets;
    }

    const scenarios = {
      dashboard_cold_ready_ms: scenarioResult({ samples: coldBoot, phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      warm_relaunch_ready_ms: scenarioResult({ samples: [warmRelaunch], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      first_interaction_accepted_ms: scenarioResult({ samples: [composerReady], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      fleet_reveal_ms: scenarioResult({ samples: [fleetReveal], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      active_context_reveal_ms: scenarioResult({ samples: [activeContext], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      composer_keystroke_to_paint_ms: scenarioResult({ samples: keystrokes, phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      tab_switch_ms: scenarioResult({ samples: tabSwitches, phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      repo_inventory_ms: scenarioResult({
        samples: [],
        phaseNames: DATA_PHASE_NAMES,
        unavailableReason: blocked ?? 'inventory is the final measured step and has not run yet',
      }),
      design_arm_ms: scenarioResult({ samples: [design.design_arm_ms], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      design_hover_ms: scenarioResult({ samples: [design.design_hover_ms], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      design_select_ms: scenarioResult({ samples: [design.design_select_ms], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      design_prompt_ready_ms: scenarioResult({ samples: [design.design_prompt_ready_ms], phaseNames: PHASE_NAMES, unavailableReason: blocked }),
      design_screenshot_crop_ms: scenarioResult({
        samples: [],
        phaseNames: PHASE_NAMES,
        // Not a measurement failure: the in-app Design Mode path has no crop to
        // measure yet. DesignModeOverlay records it as part 2 of the feature.
        unavailableReason: 'the embedded-browser Design Mode path does not capture a screenshot crop in this build; DesignModeOverlay marks the crop as a later phase of the feature',
      }),
    };

    // Calibration is harness-owned and must run even when the measured product
    // cannot navigate or restore its composer. Product unavailability remains
    // explicit in scenarios; it never waives the injected-delay proof.
    const falsification = await runFalsification({ browser, runConfig, scenarios, target, stack });

    // Inventory is intentionally last. Older packaged servers may continue an
    // expensive repository scan after the browser aborts its bounded request;
    // running it earlier would contaminate every later UI measurement. A
    // censored timeout is still a numeric budget failure, then teardown stops
    // the isolated server immediately after this final observation.
    inventory = blocked ? [] : await sampleRepoInventory(
      page,
      Math.min(runConfig.samples, 5),
      runConfig.inventoryTimeoutMs,
    );
    scenarios.repo_inventory_ms = scenarioResult({
      samples: inventory,
      phaseNames: DATA_PHASE_NAMES,
      unavailableReason: blocked,
    });

    contextCloseTimedOut = await closeContextBounded(context);
    context = null;
    const observedRepoCount = inventory.map((sample) => sample.repoCount).find((value) => Number.isFinite(value)) ?? null;
    // Read the worktree list while the fixture repo still exists: closing the
    // stack deletes the data dir, and an absent repo cannot prove absence of
    // worktrees.
    const worktreesAfter = listWorktrees(fixture.repoDir);
    // Terminal sessions the fixture stack started are ours to remove; sessions
    // rooted anywhere else belong to the operator and are only reported.
    const killedTmuxSessions = killTmuxSessions(ownedTmuxSessions(fixture.dataDir));
    if (inventoryTimer) clearInterval(inventoryTimer);
    inventoryTimer = null;
    captureOwnedProcessTree(ownedInventory);
    const processTermination = await terminateAndWaitOwnedProcesses(ownedInventory, { graceMs: 0 });
    await stack.close();
    const closedStack = stack;
    stack = null;
    // A process killed mid-write can recreate files after its own teardown
    // removed them, so remove once more here and let verifyCleanup judge the
    // result rather than a race.
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    await fixturePage.close();
    const closedFixturePage = fixturePage;
    fixturePage = null;
    const cleanup = await verifyCleanup({
      processTermination,
      ports: [closedStack.apiPort, closedStack.wsPort, closedFixturePage.port],
      dataDir: fixture.dataDir,
      repoDir: fixture.repoDir,
      tmuxSessionsBefore,
      worktreesBefore,
      worktreesAfter,
    });
    cleanup.killedTmuxSessions = killedTmuxSessions;

    return {
      scale,
      fixture: {
        scale,
        seed: runConfig.seed,
        digest: fixture.digest,
        repoCount: fixture.repoCount,
        observedRepoCount,
        revealedRows: fleetReveal.rows ?? null,
        project: fixture.project,
        designPageDigest: closedFixturePage.digest,
        workspaceTabs: fixture.tabs.map((tab) => tab.id),
      },
      target,
      stack: {
        buildMode: closedStack.buildMode,
        apiPort: closedStack.apiPort,
        wsPort: closedStack.wsPort,
        releaseArtifact: closedStack.releaseArtifact ?? null,
      },
      warmRelaunchFacets: restoredState,
      scenarios,
      soak,
      falsification,
      cleanup,
      contention: { before: contentionBefore, after: contentionSnapshot() },
      consoleErrors: opened.consoleErrors,
      browserContextCloseTimedOut: contextCloseTimedOut,
      durationMs: Date.now() - startedAt,
      unavailableReason: blocked,
    };
  } finally {
    if (inventoryTimer) clearInterval(inventoryTimer);
    if (context) await closeContextBounded(context);
    if (stack) await stack.close().catch(() => undefined);
    if (fixturePage) await fixturePage.close().catch(() => undefined);
    captureOwnedProcessTree(ownedInventory);
    await terminateAndWaitOwnedProcesses(ownedInventory).catch(() => undefined);
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  }
}

// The falsification probe. It replays the keystroke path with a deliberate
// main-thread stall injected into the same interaction and requires the budget
// evaluator to reject the result. A harness that stays green here is broken.
async function runFalsification({ browser, runConfig, scenarios, target, stack }) {
  if (runConfig.injectedDelayMs <= 0) return { skippedReason: 'falsification disabled (--inject-delay-ms=0)' };
  let context = null;
  try {
    // Calibration must not depend on the measured release successfully
    // restoring its fixture chat. Use a harness-owned editable control while
    // keeping the exact same trusted keypress and paint observer as the product
    // measurement. This isolates "can the instrument detect a regression?"
    // from "did this build render its composer?"; the latter remains a normal
    // scenario failure.
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(instrumentationInitScript, { injectedDelayMs: runConfig.injectedDelayMs });
    await page.goto(
      `data:text/html,${encodeURIComponent('<!doctype html><html><body><textarea data-o8-active-composer="true" autofocus></textarea></body></html>')}`,
      { waitUntil: 'domcontentloaded', timeout: 10_000 },
    );
    await page.locator(COMPOSER_SELECTOR).waitFor({ state: 'visible', timeout: 5_000 });
    const delayed = await sampleKeystrokes(page, Math.max(3, Math.min(runConfig.samples, 5)));
    const delayedScenario = scenarioResult({ samples: delayed, phaseNames: PHASE_NAMES });
    const injectedDelayApplications = await page.evaluate(() => (
      globalThis.__o8Interactions?.injectedDelayApplications ?? 0
    ));
    const injectedReceipt = {
      schema: SCHEMA,
      target,
      stack: { buildMode: stack.buildMode },
      fixture: { scale: null },
      scenarios: { ...scenarios, composer_keystroke_to_paint_ms: delayedScenario },
      soak: {},
    };
    // Absolute budgets are forced here: the probe asks whether the instrument
    // can detect an injected regression, not whether this build mode is
    // budget-eligible.
    const evaluation = evaluateInteractionBudgets(injectedReceipt, null, { forceAbsolute: true });
    const failedMetric = evaluation.results.find((result) => (
      result.status === 'fail' && result.metric.startsWith('composer_keystroke_to_paint')
    ));
    return {
      injectedDelayMs: runConfig.injectedDelayMs,
      metric: failedMetric?.metric ?? 'composer_keystroke_to_paint_ms',
      budgetMax: failedMetric?.budgetMax ?? INTERACTION_BUDGETS.metrics.composer_keystroke_to_paint_ms.max,
      baselineP50: scenarios.composer_keystroke_to_paint_ms.distribution.p50,
      baselineP95: scenarios.composer_keystroke_to_paint_ms.distribution.p95,
      injectedP50: delayedScenario.distribution.p50,
      injectedP95: delayedScenario.distribution.p95,
      samples: delayedScenario.distribution.samples,
      injectedDelayApplications,
      delayExecuted: Number.isInteger(injectedDelayApplications) && injectedDelayApplications > 0,
      budgetFailed: Boolean(failedMetric),
      note: failedMetric
        ? null
        : `injected delay did not breach any keystroke budget; observed p50 ${delayedScenario.distribution.p50 ?? 'null'}ms`,
    };
  } catch (error) {
    return { skippedReason: `falsification probe failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (context) await closeContextBounded(context);
  }
}

function unavailableReceipt(runConfig, reason) {
  const identity = benchmarkIdentity(ROOT);
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    version: identity.version,
    gitSha: identity.gitSha,
    runStatus: 'unavailable',
    unavailableReason: reason,
    host: hostProfile(),
    budgetManifest: INTERACTION_BUDGETS.status,
    scales: runConfig.scales,
    runs: [],
    validity: ['harness did not run'],
  };
}

export { baselineFromReceipt, deriveRunStatus } from './interactions/receipt.mjs';

async function main() {
  const runConfig = interactionConfig(ROOT);
  runConfig.runTag = `o8-interactions-${process.pid}-${Date.now()}`;
  const startedAt = Date.now();
  const contentionBefore = contentionSnapshot();
  const browserPath = resolveBrowserPath();
  if (!browserPath) {
    const receipt = unavailableReceipt(runConfig, 'Chrome or Chromium is unavailable');
    writeReceipt(runConfig.outputPath, receipt);
    console.log(`[bench:interactions] ${receipt.unavailableReason}; wrote ${path.relative(ROOT, runConfig.outputPath)}`);
    return 0;
  }
  const baseline = readBaseline(ROOT, runConfig.baselinePath);
  const runs = [];
  const browserCleanup = [];
  for (const scale of runConfig.scales) {
    process.stdout.write(`[bench:interactions] scale=${scale}\n`);
    const browserState = await launchMeasuredBrowser(browserPath, `${runConfig.runTag}-browser-${scale}`);
    let run;
    try {
      run = await measureScale({
        browser: browserState.browser,
        browserPid: browserState.browserPid,
        scale,
        runConfig,
      });
    } catch (error) {
      run = {
        scale,
        fixture: { scale },
        target: null,
        stack: { buildMode: null, releaseArtifact: null },
        scenarios: {},
        soak: { unavailableReason: 'scale measurement aborted' },
        falsification: { skippedReason: 'scale measurement aborted' },
        cleanup: null,
        unavailableReason: `scale measurement aborted: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      browserCleanup.push({ scale, ...await closeMeasuredBrowser(browserState) });
    }
    const budgets = evaluateInteractionBudgets(
      { ...run, fixture: run.fixture, target: run.target, stack: run.stack },
      baseline,
    );
    runs.push({ ...run, budgets, validity: checkReceiptValidity({ ...run, schema: SCHEMA }) });
  }

  const browserSurvivors = browserCleanup.flatMap((cleanup) => cleanup.survivors);
  const browserSnapshotErrors = browserCleanup.flatMap((cleanup) => cleanup.snapshotErrors ?? []);
  const { runStatus, validity } = deriveRunStatus(
    runs,
    [
      ...(browserSurvivors.length > 0
        ? [`browser processes survived cleanup: ${JSON.stringify(browserSurvivors)}`]
        : []),
      ...(browserSnapshotErrors.length > 0
        ? [`browser process inventory failed: ${[...new Set(browserSnapshotErrors)].join('; ')}`]
        : []),
    ],
  );

  const identity = benchmarkIdentity(ROOT);
  const composed = runConfig.composeTerminalWorkload
    ? { terminalWorkload: readTerminalWorkloadComposition(ROOT, { measuredTarget: runs[0]?.target ?? null }) }
    : { terminalWorkload: { status: 'unavailable', unavailableReason: 'composition disabled with --no-compose' } };
  const receipt = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    // Identity of the checkout that RAN the benchmark; run.target identifies
    // the build that was MEASURED. They are deliberately separate.
    version: identity.version,
    gitSha: identity.gitSha,
    runStatus,
    budgetManifest: INTERACTION_BUDGETS.status,
    budgets: INTERACTION_BUDGETS.metrics,
    baselineSource: baseline?.source ?? null,
    host: hostProfile(),
    contention: { before: contentionBefore, after: contentionSnapshot() },
    scales: runConfig.scales,
    samples: runConfig.samples,
    targetLane: {
      kind: runConfig.target.kind,
      appPath: runConfig.target.appPath,
      releaseArtifact: runs[0]?.stack?.releaseArtifact ?? null,
    },
    // Terminal keystroke-to-paint at N=1/4/12 and rapid tab/pane switching are
    // owned by the operator-locked terminal-workload lane. They are composed in
    // here with provenance instead of being re-derived weakly.
    composed,
    browserCleanup,
    validity,
    runs,
  };
  writeReceipt(runConfig.outputPath, receipt);
  if (runConfig.writeBaseline) {
    const baseline = baselineFromReceipt(receipt);
    // A release observation is named for the artifact it measured, so the two
    // shipped-build observations #1697 requires coexist and can be diffed.
    const appVersion = runs[0]?.target?.appVersion ?? null;
    const baselinePath = runConfig.target.kind === 'release' && appVersion
      ? path.join(path.dirname(runConfig.baselinePath), `interactions-baseline-release-${appVersion}.json`)
      : runConfig.baselinePath;
    writeReceipt(baselinePath, baseline);
    console.log(`[bench:interactions] release observation written to ${path.relative(ROOT, baselinePath)}`);
  }
  printSummary(receipt);
  console.log(`[bench:interactions] status=${runStatus} wrote ${path.relative(ROOT, runConfig.outputPath)}`);
  if (runConfig.reportOnly && (runStatus === 'fail' || runStatus === 'invalid')) {
    console.log('[bench:interactions] --report-only: status reported, exit code suppressed for the chained speed lane');
    return 0;
  }
  return runStatus === 'fail' || runStatus === 'invalid' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[bench:interactions] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
