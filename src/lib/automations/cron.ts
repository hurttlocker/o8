/**
 * cron.ts — tiny standard-5-field cron parser + next-fire calculator.
 *
 * Supports `*`, plain numbers, comma lists, ranges (a-b), and step
 * shorthand (`*` /N or `a-b/N`). No fancy aliases (`@hourly` etc.) for v1 —
 * the page UI nudges users toward standard expressions and the create-form
 * validator below will reject anything else.
 *
 * Fields: `minute hour day-of-month month day-of-week`.
 * Range conventions: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6
 * (Sunday=0; Cron's traditional 7=Sunday alias is mapped to 0).
 *
 * NOTE: when BOTH `day-of-month` and `day-of-week` are restricted (neither
 * is `*`), standard cron fires when EITHER matches. We follow that.
 */

interface ParsedExpr {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function expandField(field: string, min: number, max: number, dowAlias?: boolean): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangeStr, stepStr] = part.split('/');
    const step = stepStr ? Number.parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`invalid step in "${part}"`);
    }
    let start: number;
    let end: number;
    if (rangeStr === '*') {
      start = min;
      end = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map((s) => Number.parseInt(s, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`invalid range "${rangeStr}"`);
      start = a;
      end = b;
    } else {
      const v = Number.parseInt(rangeStr, 10);
      if (!Number.isFinite(v)) throw new Error(`invalid number "${rangeStr}"`);
      start = v;
      end = v;
    }
    // dow alias: 7 -> 0 (Sunday).
    if (dowAlias && start === 7) start = 0;
    if (dowAlias && end === 7) end = 0;
    if (start < min || end > max || start > end) {
      throw new Error(`out-of-range "${part}" (allowed ${min}..${max})`);
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr: string): ParsedExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected 5 fields, got ${parts.length}: "${expr}"`);
  }
  const [m, h, dom, mon, dow] = parts;
  return {
    minute: expandField(m, 0, 59),
    hour: expandField(h, 0, 23),
    dom: expandField(dom, 1, 31),
    month: expandField(mon, 1, 12),
    dow: expandField(dow, 0, 6, true),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/**
 * Quick boolean check — does `expr` parse cleanly?
 * Returns false on any structural error.
 */
export function validateCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function cronMatches(parsed: ParsedExpr, date: Date): boolean {
  const dom = date.getDate();
  const dow = date.getDay();
  const dayMatches = parsed.domRestricted && parsed.dowRestricted
    ? parsed.dom.has(dom) || parsed.dow.has(dow)
    : parsed.domRestricted
      ? parsed.dom.has(dom)
      : parsed.dowRestricted
        ? parsed.dow.has(dow)
        : true;
  return parsed.minute.has(date.getMinutes())
    && parsed.hour.has(date.getHours())
    && parsed.month.has(date.getMonth() + 1)
    && dayMatches;
}

/**
 * Compute the next minute (>= fromMs) when the cron expression fires.
 * Returns null if no match within a year (effectively "never" — pathological
 * cron like `0 0 31 2 *`).
 */
export function computeNextRunAt(expr: string, fromMs: number): number | null {
  let parsed: ParsedExpr;
  try { parsed = parseCron(expr); }
  catch { return null; }

  // Start at the next whole minute after fromMs.
  const d = new Date(fromMs);
  d.setMilliseconds(0);
  d.setSeconds(0);
  d.setMinutes(d.getMinutes() + 1);

  const ceilingMs = fromMs + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= ceilingMs) {
    if (cronMatches(parsed, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Compute the latest matching minute at or before `atOrBeforeMs`. */
export function computePreviousRunAt(expr: string, atOrBeforeMs: number): number | null {
  let parsed: ParsedExpr;
  try { parsed = parseCron(expr); }
  catch { return null; }

  const date = new Date(atOrBeforeMs);
  date.setMilliseconds(0);
  date.setSeconds(0);
  const floorMs = date.getTime();
  const earliestMs = floorMs - 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() >= earliestMs) {
    if (cronMatches(parsed, date)) return date.getTime();
    date.setMinutes(date.getMinutes() - 1);
  }
  return null;
}
