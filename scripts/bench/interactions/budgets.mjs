import { packagedTargetIdentityProblems } from './targets.mjs';

// Absolute interaction budgets. These are PROVISIONAL: the issue requires a
// baseline across two shipped release builds before the operator locks them.
// Each entry records its interaction-tier or already-locked terminal basis.
// They are acceptance hypotheses, not values tuned from this packet's runs.
export const INTERACTION_BUDGETS = Object.freeze({
  status: 'provisional',
  lockedBy: null,
  // Each budget cites its basis. Direct-manipulation ceilings come from the
  // repo's own interaction spec (docs/design/STYLEGUIDE.md, "Feedback timing
  // tiers"): 0-100ms means the result IS the feedback, 100ms-1s needs a busy
  // state, 1-3s needs a local spinner, 3s+ needs named stages. A surface that
  // exceeds its tier either gets faster or grows the feedback its tier demands.
  metrics: Object.freeze({
    dashboard_cold_ready_ms: {
      scenario: 'dashboard_cold_ready_ms', statistic: 'p95', max: 4000,
      basis: 'cold shell readiness; past the 3s+ tier a launch must show named stages, and past ~4s it reads as stalled',
    },
    warm_relaunch_ready_ms: {
      scenario: 'warm_relaunch_ready_ms', statistic: 'p95', max: 3000,
      basis: 'a relaunch that restores persisted state should stay inside the 1-3s spinner tier, never the staged-label tier',
    },
    first_interaction_accepted_ms: {
      scenario: 'first_interaction_accepted_ms', statistic: 'p95', max: 2000,
      basis: 'hydration to a composer that accepts input; a shell that paints but refuses typing is not ready',
    },
    fleet_reveal_ms: {
      scenario: 'fleet_reveal_ms', statistic: 'p95', max: 1000,
      basis: 'a disclosure that reveals the fleet has no spinner in its path, so it must land inside the 100ms-1s busy tier',
    },
    active_context_reveal_ms: {
      scenario: 'active_context_reveal_ms', statistic: 'p95', max: 1000,
      basis: 'selecting a repository re-anchors the workspace; same busy tier as the reveal it follows',
    },
    composer_keystroke_to_paint_ms: {
      scenario: 'composer_keystroke_to_paint_ms', statistic: 'p50', max: 75,
      basis: 'matches the operator-locked terminal keystroke p50 so both input paths answer to one bar',
    },
    composer_keystroke_to_paint_p95_ms: {
      scenario: 'composer_keystroke_to_paint_ms', statistic: 'p95', max: 175,
      basis: 'matches the operator-locked terminal keystroke p95',
    },
    design_arm_ms: {
      scenario: 'design_arm_ms', statistic: 'p95', max: 300,
      basis: 'arming a mode is direct manipulation; the armed state must settle inside the busy tier',
    },
    design_hover_ms: {
      scenario: 'design_hover_ms', statistic: 'p95', max: 100,
      basis: 'hover feedback is the 0-100ms tier — the label IS the feedback and cannot lag the pointer',
    },
    design_select_ms: {
      scenario: 'design_select_ms', statistic: 'p95', max: 300,
      basis: 'the composer materializing after the stroke is the result of the gesture, busy tier at the outside',
    },
    design_prompt_ready_ms: {
      scenario: 'design_prompt_ready_ms', statistic: 'p95', max: 500,
      basis: 'from stroke release to a focused prompt the operator can type into',
    },
    tab_switch_ms: {
      scenario: 'tab_switch_ms', statistic: 'p95', max: 400,
      basis: 'switching a workspace tab is the same class of latency as revealing a terminal; terminal tab/pane switching under load is covered by the composed terminal-workload lane',
    },
    design_screenshot_crop_ms: {
      scenario: 'design_screenshot_crop_ms', statistic: 'p95', max: 500,
      basis: 'the crop that accompanies a Design Mode prompt; kept in the manifest so a missing capability reports itself instead of disappearing',
    },
    repo_inventory_ms: {
      scenario: 'repo_inventory_ms', statistic: 'p50', max: 1500,
      basis: 'the fleet-list request the left panel waits on, at fixture scale; p50 across five consecutive calls in the operator window',
    },
    repo_inventory_p95_ms: {
      scenario: 'repo_inventory_ms', statistic: 'p95', max: 3000,
      basis: 'the worst of those five calls; a fleet list that stalls once still stalls the operator once',
    },
    soak_long_task_ms_per_minute: {
      scenario: null, statistic: 'p95', max: 750,
      basis: 'matches the operator-locked terminal-workload long-task ceiling',
    },
  }),
  // These conservative bands are fixed before the notarized-build comparison.
  // The contaminated source receipts are quarantined and do not calibrate them.
  // Repeated clean runs may justify a later, separately reviewed calibration.
  noiseBandMs: Object.freeze({
    dashboard_cold_ready_ms: 150,
    warm_relaunch_ready_ms: 150,
    first_interaction_accepted_ms: 150,
    fleet_reveal_ms: 150,
    active_context_reveal_ms: 50,
    composer_keystroke_to_paint_ms: 15,
    composer_keystroke_to_paint_p95_ms: 40,
    design_arm_ms: 50,
    design_hover_ms: 50,
    design_select_ms: 30,
    design_prompt_ready_ms: 40,
    design_screenshot_crop_ms: 40,
    tab_switch_ms: 50,
    repo_inventory_ms: 150,
    repo_inventory_p95_ms: 300,
    soak_long_task_ms_per_minute: 150,
  }),
});

export const BUDGET_ELIGIBLE_BUILD_MODES = Object.freeze(['production', 'packaged']);

function statisticValue(scenario, statistic) {
  if (!scenario) return { value: null, note: 'scenario missing from receipt' };
  const value = scenario.distribution?.[statistic];
  if (Number.isFinite(value)) return { value, note: null };
  // The distribution note names the specific sample failure; the scenario-level
  // reason is the generic fallback. Prefer the specific one.
  return { value: null, note: scenario.distribution?.note ?? scenario.unavailableReason ?? 'measurement unavailable' };
}

export function metricObservations(receipt) {
  const scenarios = receipt?.scenarios ?? {};
  const observations = [];
  for (const [metric, spec] of Object.entries(INTERACTION_BUDGETS.metrics)) {
    if (spec.scenario === null) {
      const value = receipt?.soak?.longTaskMsPerMinute;
      observations.push({
        metric,
        scale: receipt?.fixture?.scale ?? null,
        spec,
        value: Number.isFinite(value) ? value : null,
        note: Number.isFinite(value)
          ? null
          : receipt?.soak?.longTaskUnavailableReason ?? receipt?.soak?.unavailableReason ?? 'soak not run',
      });
      continue;
    }
    observations.push({
      metric,
      scale: receipt?.fixture?.scale ?? null,
      spec,
      ...statisticValue(scenarios[spec.scenario], spec.statistic),
    });
  }
  return observations;
}

function classifyDelta(metric, value, baselineValue) {
  if (!Number.isFinite(baselineValue)) return { baselineValue: null, deltaValue: null, deltaStatus: 'no-baseline' };
  if (!Number.isFinite(value)) return { baselineValue, deltaValue: null, deltaStatus: 'missing' };
  const deltaValue = Number((value - baselineValue).toFixed(2));
  const band = INTERACTION_BUDGETS.noiseBandMs[metric] ?? 0;
  if (Math.abs(deltaValue) <= band) return { baselineValue, deltaValue, deltaStatus: 'unchanged' };
  return { baselineValue, deltaValue, deltaStatus: deltaValue > 0 ? 'regressed' : 'improved' };
}

// Absolute budgets describe a production-shaped build. A next-dev measurement
// is a real number but not a number the budget was written against, so it is
// reported with its value and an explicit reason instead of a pass.
export function budgetsApply(buildMode) {
  return BUDGET_ELIGIBLE_BUILD_MODES.includes(buildMode);
}

export function evaluateInteractionBudgets(receipt, baseline = null, { forceAbsolute = false } = {}) {
  const buildMode = receipt?.target?.buildMode ?? receipt?.stack?.buildMode ?? null;
  const absoluteApplies = forceAbsolute || budgetsApply(buildMode);
  const baselineMetrics = baseline?.metrics ?? {};
  const results = metricObservations(receipt).map((observation) => {
    const baselineMetric = baselineMetrics[`${observation.metric}@${observation.scale}`]
      ?? baselineMetrics[observation.metric];
    const delta = classifyDelta(observation.metric, observation.value, baselineMetric?.value);
    if (!Number.isFinite(observation.value)) {
      return {
        metric: observation.metric,
        statistic: observation.spec.statistic,
        scale: observation.scale,
        value: null,
        budgetMax: observation.spec.max,
        status: 'unavailable',
        reason: observation.note ?? 'measurement unavailable',
        ...delta,
      };
    }
    if (!absoluteApplies) {
      return {
        metric: observation.metric,
        statistic: observation.spec.statistic,
        scale: observation.scale,
        value: observation.value,
        budgetMax: observation.spec.max,
        status: 'unavailable',
        reason: `build mode ${buildMode ?? 'unknown'} is not budget-eligible; absolute budgets describe ${BUDGET_ELIGIBLE_BUILD_MODES.join(' or ')} builds`,
        ...delta,
      };
    }
    return {
      metric: observation.metric,
      statistic: observation.spec.statistic,
      scale: observation.scale,
      value: observation.value,
      budgetMax: observation.spec.max,
      status: observation.value > observation.spec.max ? 'fail' : 'pass',
      reason: null,
      ...delta,
    };
  });
  const failed = results.filter((result) => result.status === 'fail');
  const unavailable = results.filter((result) => result.status === 'unavailable');
  const regressed = results.filter((result) => result.deltaStatus === 'regressed');
  return {
    budgetStatus: INTERACTION_BUDGETS.status,
    buildMode,
    absoluteApplies,
    baselineSource: baseline?.source ?? null,
    status: failed.length > 0 || regressed.length > 0 ? 'fail' : unavailable.length > 0 ? 'incomplete' : 'pass',
    failed: failed.map((result) => result.metric),
    regressed: regressed.map((result) => result.metric),
    unavailable: unavailable.map((result) => ({ metric: result.metric, reason: result.reason })),
    results,
  };
}

// A harness that cannot fail proves nothing. Every receipt must carry a
// falsification probe (a deliberately delayed interaction) that the same
// evaluator rejects, and a cleanup receipt that found no residue.
export function checkReceiptValidity(receipt) {
  const problems = [];
  if (receipt?.schema !== 'o8/interaction-performance/v1') {
    problems.push(`schema must be o8/interaction-performance/v1, received ${receipt?.schema ?? 'missing'}`);
    return problems;
  }
  const falsification = receipt.falsification;
  if (!falsification) {
    problems.push('receipt is missing the deliberate-delay falsification probe');
  } else if (falsification.skippedReason) {
    problems.push(`falsification probe did not run: ${falsification.skippedReason}`);
  } else if (
    falsification.delayExecuted !== true
    || !Number.isInteger(falsification.injectedDelayApplications)
    || falsification.injectedDelayApplications < 1
  ) {
    problems.push(`injected ${falsification.injectedDelayMs ?? 'unknown'}ms render delay has no execution proof; the harness cannot falsify its measurements`);
  } else if (falsification.budgetFailed !== true) {
    problems.push(`injected ${falsification.injectedDelayMs ?? 'unknown'}ms render delay did not fail ${falsification.metric ?? 'the interaction budget'}; the harness cannot detect a regression`);
  }
  const cleanup = receipt.cleanup;
  if (!cleanup) {
    problems.push('receipt is missing the cleanup assertion');
  } else if (cleanup.status !== 'clean') {
    problems.push(`cleanup left residue: ${JSON.stringify(cleanup.residue ?? cleanup)}`);
  }
  for (const problem of packagedTargetIdentityProblems(receipt.target, receipt.stack)) {
    problems.push(`packaged target identity is incomplete: ${problem}`);
  }
  return problems;
}
