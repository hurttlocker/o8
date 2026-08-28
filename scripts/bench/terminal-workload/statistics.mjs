export function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return Number(sorted[index].toFixed(2));
}

export function distribution(values) {
  const finite = values.filter(Number.isFinite);
  return {
    samples: finite.length,
    min: finite.length > 0 ? Number(Math.min(...finite).toFixed(2)) : null,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length > 0 ? Number(Math.max(...finite).toFixed(2)) : null,
  };
}

export function summarizeSamples(samples) {
  const output = {};
  for (const sessionCount of [...new Set(samples.map((sample) => sample.sessionCount))].sort((a, b) => a - b)) {
    const group = samples.filter((sample) => sample.sessionCount === sessionCount);
    const processMetric = (processName, field) => distribution(group.map((sample) => sample.processes[processName]?.[field]));
    output[sessionCount] = {
      sampleCount: group.length,
      mountedTerminalPanels: distribution(group.map((sample) => sample.inventory.mountedTerminalPanelCount)),
      visibleTerminalPanels: distribution(group.map((sample) => sample.inventory.visibleTerminalPanelCount)),
      ptyCount: distribution(group.map((sample) => sample.inventory.ptyCount)),
      hiddenWriteBytesPerSecondPerPanel: distribution(group.map((sample) => sample.browser.hiddenWriteBytesPerSecondPerPanel)),
      hiddenWriteCallsPerSecondPerPanel: distribution(group.map((sample) => sample.browser.hiddenWriteCallsPerSecondPerPanel)),
      longTaskMsPerMinute: distribution(group.map((sample) => sample.performance.longTaskMsPerMinute)),
      revealMs: distribution(group.flatMap((sample) => sample.latency.revealMs)),
      firstCorrectFrameMs: distribution(group.flatMap((sample) => sample.latency.firstCorrectFrameMs)),
      keystrokeToPaintMs: distribution(group.flatMap((sample) => sample.latency.keystrokeToPaintMs)),
      keystrokeToPaintTimeouts: group.reduce((total, sample) => (
        total + sample.latency.keystrokeToPaintTimedOut.filter(Boolean).length
      ), 0),
      processCpuPercent: {
        applicationServer: processMetric('applicationServer', 'cpuPercent'),
        realtimeServer: processMetric('realtimeServer', 'cpuPercent'),
        chromiumRenderer: processMetric('chromiumRenderer', 'cpuPercent'),
      },
      processPhysicalBytes: {
        applicationServer: processMetric('applicationServer', 'physicalBytes'),
        realtimeServer: processMetric('realtimeServer', 'physicalBytes'),
        chromiumRenderer: processMetric('chromiumRenderer', 'physicalBytes'),
      },
      attachedClientsPerSession: group.map((sample) => sample.inventory.attachedClientsPerSession),
      initiallyUnmountedBrowserWriteBytes: distribution(group.map((sample) => sample.browser.initiallyUnmountedWriteBytes)),
      residencyChurnCount: distribution(group.map((sample) => sample.browser.residencyChurnSessionNames.length)),
      neverMountedSessionCount: distribution(group.map((sample) => sample.browser.neverMountedSessionNames.length)),
      unmountedBrowserWriteBytes: distribution(group.map((sample) => sample.browser.unmountedWriteBytes)),
      unmountedServerHiddenBytes: distribution(group.map((sample) => sample.server.unmountedHiddenBytes)),
      attribution: {
        transportJsonParseMs: distribution(group.map((sample) => sample.browser.transport.jsonParseMs)),
        base64DecodeMs: distribution(group.map((sample) => sample.browser.totalDecodeMs)),
        termWriteCallMs: distribution(group.map((sample) => sample.browser.totalWriteCallMs)),
        termWriteCompletionMs: distribution(group.map((sample) => sample.browser.totalWriteCompletionMs)),
        renderEvents: distribution(group.map((sample) => sample.browser.totalRenderEvents)),
        fanoutClientDeliveries: distribution(group.map((sample) => sample.server.fanoutClientDeliveries)),
      },
      overflowEvents: distribution(group.map((sample) => sample.server.overflowEvents)),
      backpressureDropEvents: distribution(group.map((sample) => sample.server.backpressureDropEvents)),
    };
  }
  return output;
}
