export function WorkerEventTime({ timestamp }: { timestamp?: number }) {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}
    style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, lineHeight: 1.25 }}>
    {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
  </time>;
}
