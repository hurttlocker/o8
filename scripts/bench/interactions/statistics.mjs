// Sample statistics for the interaction harness. Every helper returns explicit
// nulls when there is nothing to measure so an empty sample set can never be
// rendered as a fast result.
export function percentile(values, quantile) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return Number(sorted[index].toFixed(2));
}

export function distribution(values, { note = null } = {}) {
  const finite = (values ?? []).filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { samples: 0, min: null, p50: null, p95: null, p99: null, max: null, note: note ?? 'no samples collected' };
  }
  return {
    samples: finite.length,
    min: Number(Math.min(...finite).toFixed(2)),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max: Number(Math.max(...finite).toFixed(2)),
    ...(note ? { note } : {}),
  };
}

// Averages the per-sample phase split so a scenario can report where its time
// went, not only how long it took. Phases the platform does not expose stay
// null with the reason the runner recorded.
export function summarizePhases(samples, phaseNames) {
  const output = {};
  for (const name of phaseNames) {
    const values = (samples ?? []).map((sample) => sample?.phases?.[name]?.value ?? sample?.phases?.[name]);
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
      const reason = (samples ?? [])
        .map((sample) => sample?.phases?.[name]?.note)
        .find((note) => typeof note === 'string' && note.trim());
      output[name] = { value: null, note: reason ?? 'phase not exposed by the platform' };
      continue;
    }
    output[name] = { value: percentile(finite, 0.5), samples: finite.length };
  }
  return output;
}

export function scenarioResult({ samples, phaseNames = [], unavailableReason = null }) {
  if (unavailableReason) {
    return {
      distribution: distribution([], { note: unavailableReason }),
      phases: Object.fromEntries(phaseNames.map((name) => [name, { value: null, note: unavailableReason }])),
      censoredLowerBounds: 0,
      unavailableReason,
    };
  }
  const durations = (samples ?? []).map((sample) => sample?.durationMs);
  const failures = (samples ?? []).filter((sample) => !Number.isFinite(sample?.durationMs));
  const censoredLowerBounds = (samples ?? []).filter((sample) => sample?.censoredLowerBound === true);
  return {
    distribution: distribution(durations, {
      note: failures.length > 0 ? `${failures.length} sample(s) failed: ${failures.map((sample) => sample?.note ?? 'unknown').join('; ')}` : null,
    }),
    phases: summarizePhases(samples, phaseNames),
    censoredLowerBounds: censoredLowerBounds.length,
    ...(censoredLowerBounds.length > 0 ? {
      lowerBoundNote: censoredLowerBounds.map((sample) => sample.note).filter(Boolean).join('; '),
    } : {}),
    unavailableReason: durations.some((value) => Number.isFinite(value)) ? null : 'no sample produced a duration',
  };
}
