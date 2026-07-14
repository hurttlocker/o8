/**
 * Shared machinery for the "publish only wins" loop.
 *
 * Two consumers, one source of truth:
 *   - scripts/publish-fixed.mjs  → announces fixes in the public #fixed channel
 *   - scripts/release.mjs        → ships fixed.json next to latest.json so the
 *                                  reporter's own app can tell them
 *
 * The manifest is CUMULATIVE, deliberately. A per-release list would lose a fix
 * for anyone who skips versions: report fixed in 0.1.585, operator jumps
 * 0.1.580 → 0.1.592, receipt never arrives. `/releases/latest/download/fixed.json`
 * always resolves to the newest release, so one rolling file always carries
 * everything.
 *
 * Nothing here is identifying: a report id is an opaque 6-char code, and the
 * exact same ids are already public in #fixed. The reporter's app does the join
 * LOCALLY against its own ledger — it never uploads anything.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANIFEST_SCHEMA = 1;

export function dataDir() {
  return process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8');
}
export function feedbackDir() {
  return path.join(dataDir(), 'feedback');
}
export function ledgerPath() {
  return path.join(feedbackDir(), 'reports.jsonl');
}
export function publishedPath() {
  return path.join(feedbackDir(), 'published.json');
}
export function statusPath() {
  return path.join(feedbackDir(), 'status.jsonl');
}

/**
 * Report status. `fixed` is set by the `Fixes-Report:` trailer at ship time; the
 * rest are set by hand (npm run reports).
 *
 * PUBLIC vs INTERNAL is the load-bearing distinction. The fix manifest is a public
 * download, so we publish WINS and ASKS, never WOUNDS:
 *   - fixed      → public. The win.
 *   - needs-info → public. An ask for help, not an admission — and the single most
 *                  valuable thing to say to someone whose bug we can't reproduce.
 *   - everything else → INTERNAL. A publicly scrapeable list of "o8 won't fix
 *                  these" is precisely the rot board we refused to build.
 */
export const STATUSES = ['open', 'triaged', 'attempted', 'needs-info', 'cant-reproduce', 'wont-fix', 'fixed'];
export const PUBLIC_STATUSES = new Set(['fixed', 'needs-info']);

/** Append a status event. Never throws. */
export function recordStatus(event) {
  try {
    const dir = feedbackDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(statusPath(), `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Latest status per report + the full note history.
 * Append-only: the file is the audit trail, this is the projection.
 */
export function readStatus() {
  const byId = new Map();
  try {
    const file = statusPath();
    if (!existsSync(file)) return byId;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (!event?.id) continue;
        const id = String(event.id).toUpperCase();
        const current = byId.get(id) ?? { status: 'open', notes: [] };
        if (event.status) current.status = event.status;
        if (event.note) current.notes.push({ note: event.note, ts: event.ts, status: event.status ?? null });
        current.ts = event.ts;
        byId.set(id, current);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    /* unreadable — everything reads as open */
  }
  return byId;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function defaultRange() {
  try {
    const latest = git(['describe', '--tags', '--abbrev=0']);
    // Ship-time trap: release.mjs runs AFTER `npm version patch` has already
    // tagged HEAD, so `<latest>..HEAD` is EMPTY — every Fixes-Report trailer
    // between the previous release and this one would be silently dropped and
    // the whole receipt loop would never fire. When HEAD is exactly the latest
    // tag, the fixes to resolve are the ones since the PREVIOUS tag.
    let headTag = null;
    try {
      headTag = git(['describe', '--tags', '--exact-match', 'HEAD']);
    } catch {
      // HEAD is not tagged — the normal ad-hoc `publish:fixed` case.
    }
    if (headTag && headTag === latest) {
      try {
        return `${git(['describe', '--tags', '--abbrev=0', `${latest}^`])}..HEAD`;
      } catch {
        // The latest tag is the only tag in history.
        return 'HEAD~20..HEAD';
      }
    }
    return `${latest}..HEAD`;
  } catch {
    // No tags yet (fresh clone, or a repo that has never released).
    return 'HEAD~20..HEAD';
  }
}

/**
 * Every `Fixes-Report:` trailer in the range → the commit that carried it.
 * Accepts `Fixes-Report: A7F3K2` and `Fixes-Report: A7F3K2, B2M9QP`.
 */
export function collectFixedIds(range) {
  // Field-delimited with \x00 (git forbids NUL in messages) and RECORD-LED by
  // \x01. The old `\x00\x00` record TERMINATOR was ambiguous: a commit with an
  // EMPTY body ("0.1.592" — every `npm version patch` commit) emitted three
  // consecutive NULs, shifting the framing so the NEXT commit's sha parsed
  // empty and its Fixes-Report trailers silently dropped.
  const raw = git(['log', range, '--format=%x01%H%x00%s%x00%b']);
  const found = new Map();

  for (const entry of raw.split('\x01')) {
    const [sha, subject, body] = entry.split('\x00');
    if (!sha?.trim()) continue;
    const text = `${subject ?? ''}\n${body ?? ''}`;
    for (const match of text.matchAll(/^\s*Fixes-Report:\s*(.+)$/gim)) {
      for (const id of match[1].split(/[,\s]+/)) {
        const clean = id.trim().toUpperCase();
        if (clean && !found.has(clean)) {
          found.set(clean, { sha: sha.trim().slice(0, 8), subject: (subject ?? '').trim() });
        }
      }
    }
  }
  return found;
}

/** The local report ledger, keyed by id. */
export function readLedger() {
  const file = ledgerPath();
  if (!existsSync(file)) return new Map();
  const byId = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record?.id) byId.set(String(record.id).toUpperCase(), record);
    } catch {
      // skip malformed line
    }
  }
  return byId;
}

/**
 * Everything already announced — the dedupe set AND the manifest's source.
 * Reads the legacy `{ ids: [...] }` shape too, so an early install doesn't
 * re-announce every fix it ever published.
 */
export function readPublished() {
  try {
    const file = publishedPath();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.fixed)) return parsed.fixed;
    if (Array.isArray(parsed?.ids)) {
      // Legacy: ids only, no titles. Keep them deduped; they just can't be
      // rendered in a receipt.
      return parsed.ids.map((id) => ({ id: String(id).toUpperCase() }));
    }
    return [];
  } catch {
    return [];
  }
}

export function writePublished(entries) {
  const dir = feedbackDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(publishedPath(), `${JSON.stringify({ fixed: entries }, null, 2)}\n`, 'utf8');
}

export function appVersion(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve the fixes in `range` that have NOT been announced yet.
 * Returns { entries, missing } — `missing` is a trailer naming an id we have no
 * record of, which is a report that gets fixed and whose author is never told.
 * Callers must surface it, never swallow it.
 */
export function resolveNewFixes(range, version) {
  const trailers = collectFixedIds(range);
  const ledger = readLedger();
  const published = readPublished();
  const seen = new Set(published.map((entry) => entry.id));

  const entries = [];
  const missing = [];

  for (const [id, commit] of trailers) {
    if (seen.has(id)) continue;
    const report = ledger.get(id);
    if (!report) {
      missing.push({ id, commit });
      continue;
    }
    entries.push({
      id,
      title: report.title,
      reporter: report.reporter ?? null,
      version,
      sha: commit.sha,
      ts: Date.now(),
    });
  }

  return { entries, missing, published };
}

/**
 * The public manifest. Deliberately drops `reporter` and `sha` — the app only
 * needs to answer "was MY report fixed, and in which version". Shipping a
 * GitHub-handle list to every install would be a needless identity leak.
 */
export function buildManifest(published, generatedAt, { status = readStatus(), reports = readLedger() } = {}) {
  const fixed = published
    .filter((entry) => entry.id && entry.title && entry.version)
    .map((entry) => ({ id: entry.id, title: entry.title, version: entry.version, status: 'fixed' }));

  // Asks ride along with the wins. A reporter whose bug we cannot reproduce hears
  // "we looked at this, can you tell us X" instead of silence — which is the whole
  // reason the loop exists. Wounds (wont-fix / cant-reproduce / attempted) stay
  // internal: see PUBLIC_STATUSES.
  const announced = new Set(fixed.map((entry) => entry.id));
  const asks = [];
  for (const [id, state] of status) {
    if (announced.has(id)) continue;               // already fixed — the win wins
    if (!PUBLIC_STATUSES.has(state.status)) continue;
    const report = reports.get(id);
    if (!report?.title) continue;
    const latest = [...state.notes].reverse().find((n) => n.note);
    asks.push({
      id,
      title: report.title,
      version: report.version ?? 'unknown',
      status: state.status,
      // The note IS the ask — without it the card has nothing to say.
      ...(latest?.note ? { note: latest.note } : {}),
    });
  }

  return { schema: MANIFEST_SCHEMA, generatedAt, fixed: [...fixed, ...asks] };
}
