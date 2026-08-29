export const LOCKED_TERMINAL_WORKLOAD_BUDGETS = Object.freeze({
  sessionCount: 12,
  minimumSamplesPerSessionCount: 3,
  cpuPercent: {
    rendererP95Max: 35,
    rendererP95GrowthOverN1Max: 15,
    realtimeServerP95Max: 42,
    realtimeServerP50StrictMax: 25,
  },
  longTaskMsPerMinuteP95Max: 750,
  physicalBytesP95Max: {
    applicationServer: 512 * 1024 * 1024,
    realtimeServer: 224 * 1024 * 1024,
    chromiumRenderer: 288 * 1024 * 1024,
  },
  rendererPhysicalBytesGrowthP95Max: 112 * 1024 * 1024,
  revealMsP95Max: 225,
  firstCorrectFrameMsP95Max: 350,
  keystrokeToPaintMsP50Max: 75,
  keystrokeToPaintMsP95Max: 175,
  renderEventsN12ToN1MaxRatio: 1.25,
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function checkTerminalWorkloadBudgets(receipt) {
  const failures = [];
  const budget = LOCKED_TERMINAL_WORKLOAD_BUDGETS;
  if (receipt?.schema !== 'o8/terminal-workload/v1') {
    failures.push(`schema must be o8/terminal-workload/v1, received ${receipt?.schema ?? 'missing'}`);
    return failures;
  }
  const n1 = receipt.summary?.['1'] ?? receipt.summary?.[1];
  const n12 = receipt.summary?.['12'] ?? receipt.summary?.[12];
  if (!n1 || !n12) {
    failures.push('receipt must contain N=1 and N=12 summaries');
    return failures;
  }
  if ((n1.sampleCount ?? 0) < budget.minimumSamplesPerSessionCount || (n12.sampleCount ?? 0) < budget.minimumSamplesPerSessionCount) {
    failures.push(`N=1 and N=12 require at least ${budget.minimumSamplesPerSessionCount} samples`);
  }
  const assertMax = (label, value, max) => {
    if (!finite(value) || value > max) failures.push(`${label} ${value ?? 'missing'} exceeds ${max}`);
  };
  const rendererN1P95 = n1.processCpuPercent?.chromiumRenderer?.p95;
  const rendererN12P95 = n12.processCpuPercent?.chromiumRenderer?.p95;
  assertMax('renderer CPU p95', rendererN12P95, budget.cpuPercent.rendererP95Max);
  if (!finite(rendererN1P95) || !finite(rendererN12P95)
    || rendererN12P95 - rendererN1P95 > budget.cpuPercent.rendererP95GrowthOverN1Max) {
    failures.push(`renderer CPU p95 growth ${finite(rendererN1P95) && finite(rendererN12P95) ? rendererN12P95 - rendererN1P95 : 'missing'} exceeds ${budget.cpuPercent.rendererP95GrowthOverN1Max}`);
  }
  assertMax('realtime-server CPU p95', n12.processCpuPercent?.realtimeServer?.p95, budget.cpuPercent.realtimeServerP95Max);
  const realtimeP50 = n12.processCpuPercent?.realtimeServer?.p50;
  if (!finite(realtimeP50) || realtimeP50 >= budget.cpuPercent.realtimeServerP50StrictMax) {
    failures.push(`realtime-server CPU p50 ${realtimeP50 ?? 'missing'} must be below ${budget.cpuPercent.realtimeServerP50StrictMax}`);
  }
  assertMax('long-task ms/min p95', n12.longTaskMsPerMinute?.p95, budget.longTaskMsPerMinuteP95Max);
  for (const [processName, max] of Object.entries(budget.physicalBytesP95Max)) {
    assertMax(`${processName} physical bytes p95`, n12.processPhysicalBytes?.[processName]?.p95, max);
  }
  assertMax(
    'renderer physical-byte growth p95',
    n12.processPhysicalBytesGrowth?.chromiumRenderer?.p95,
    budget.rendererPhysicalBytesGrowthP95Max,
  );
  assertMax('reveal p95', n12.revealMs?.p95, budget.revealMsP95Max);
  assertMax('first-correct-frame p95', n12.firstCorrectFrameMs?.p95, budget.firstCorrectFrameMsP95Max);
  assertMax('keystroke-to-paint p50', n12.keystrokeToPaintMs?.p50, budget.keystrokeToPaintMsP50Max);
  assertMax('keystroke-to-paint p95', n12.keystrokeToPaintMs?.p95, budget.keystrokeToPaintMsP95Max);
  if ((n12.keystrokeToPaintTimeouts ?? 0) !== 0) {
    failures.push(`visible-input timeouts must be zero, received ${n12.keystrokeToPaintTimeouts}`);
  }
  const renderN1 = n1.attribution?.renderEvents?.p95;
  const renderN12 = n12.attribution?.renderEvents?.p95;
  if (!finite(renderN1) || !finite(renderN12) || renderN12 > renderN1 * budget.renderEventsN12ToN1MaxRatio) {
    failures.push(`N=12 render events p95 ${renderN12 ?? 'missing'} exceeds ${budget.renderEventsN12ToN1MaxRatio}× N=1 (${renderN1 ?? 'missing'})`);
  }

  const n12Samples = (receipt.samples ?? []).filter((sample) => sample.sessionCount === budget.sessionCount);
  const correctnessFailures = n12Samples.reduce((total, sample) => total + (sample.correctness?.failures ?? 1), 0);
  const correctnessTimeouts = n12Samples.reduce((total, sample) => total + (sample.correctness?.timeouts ?? 1), 0);
  if (correctnessFailures !== 0) failures.push(`terminal correctness failures must be zero, received ${correctnessFailures}`);
  if (correctnessTimeouts !== 0) failures.push(`terminal correctness timeouts must be zero, received ${correctnessTimeouts}`);
  if (n12Samples.some((sample) => sample.rapidSwitch?.passed !== true)) {
    failures.push('every N=12 sample must pass the 30-second rapid-switch assertion');
  }
  for (const sample of receipt.samples ?? []) {
    const label = `N=${sample.sessionCount ?? 'unknown'} sample=${sample.sampleIndex ?? 'unknown'}`;
    if ((sample.orchestratorLaunches ?? 1) !== 0) {
      failures.push(`${label} orchestrator launches must be zero, received ${sample.orchestratorLaunches ?? 'missing'}`);
    }
    if ((sample.diagnostics?.resyncUnsettledCount ?? 0) !== 0) {
      failures.push(`${label} terminal_resync_unsettled diagnostics must be zero`);
    }
    if ((sample.diagnostics?.resyncFailedCount ?? 0) !== 0) {
      failures.push(`${label} terminal_resync_failed diagnostics must be zero`);
    }
  }
  return failures;
}

export function assertTerminalWorkloadBudgets(receipt) {
  const failures = checkTerminalWorkloadBudgets(receipt);
  if (failures.length > 0) {
    throw new Error(`terminal workload budget check failed:\n- ${failures.join('\n- ')}`);
  }
}
