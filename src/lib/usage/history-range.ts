/** Calendar-day ranges in the requested zone; Past 24h stays an exact duration. */
export function historyRange(days: 1 | 7 | 30 | 90, until: number, timeZone: string) {
  if (days === 1) return { since: until - 86_400_000, until };
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(until).split('-').map(Number);
  const target = Date.UTC(parts[0], parts[1] - 1, parts[2] - (days - 1));
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let since = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const values = Object.fromEntries(formatter.formatToParts(since).map(part => [part.type, Number(part.value)]));
    const local = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    const adjusted = target - (local - since); if (adjusted === since) break; since = adjusted;
  }
  return { since, until };
}
