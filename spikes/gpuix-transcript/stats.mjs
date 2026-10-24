export function percentile(values, q) {
  if (!values.length) throw Error('No valid samples');
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index), fraction = index - lower;
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * fraction;
}
export const median = values => percentile(values, 0.5);
export function frameSummary(records, period = 1000 / 60) {
  const frames = records.filter(row => row.kind === 'frame');
  const intervals = frames.slice(1).map((row, i) => row.t - frames[i].t).filter(ms => ms > 0);
  return { p50: percentile(intervals, 0.5), p95: percentile(intervals, 0.95), p99: percentile(intervals, 0.99),
    frames: frames.length, samples: intervals.length,
    dropped: intervals.reduce((total, ms) => total + Math.max(0, Math.round(ms / period) - 1), 0) };
}
