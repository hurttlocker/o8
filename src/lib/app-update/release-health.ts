/**
 * Updater kill-switch. Before applying an auto-update, o8 consults a small
 * release-health manifest published alongside releases. If the target version
 * is listed as `pulled`, the update is skipped and a quiet note is surfaced.
 *
 * FAIL-OPEN by design: any fetch error, timeout, or malformed JSON means we
 * PROCEED with the update normally. The kill-switch can only ever STOP a known-
 * bad version — it must never block a healthy update because the manifest was
 * briefly unreachable.
 *
 * The manifest lives in the public releases repo and is operator-edited after a
 * bad release ships. Schema (see config/release-health.example.json):
 *   { "pulled": ["0.1.567"], "note": "0.1.567 crashes on launch — skipped." }
 *
 * NOTE ON THE FETCH SEAM: the desktop webview CSP does not allow connecting to
 * raw.githubusercontent.com, so `evaluateReleaseHealth` runs SERVER-SIDE (the
 * gated /api/panel/release-health route). The pure decision helpers below are
 * environment-agnostic and unit-tested directly.
 */

export const RELEASE_HEALTH_URL =
  'https://raw.githubusercontent.com/hurttlocker/o8-releases/main/release-health.json';

export interface ReleaseHealth {
  /** Versions that must NOT be auto-applied (with or without a leading 'v'). */
  pulled: string[];
  /** Optional human note shown when a version is skipped. */
  note?: string;
}

export interface ReleaseHealthDecision {
  pulled: boolean;
  note?: string;
}

/** Normalize a version string for comparison — strip a leading 'v', trim. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/**
 * Parse an untrusted JSON payload into a ReleaseHealth, or null if it doesn't
 * match the schema. Pure — never throws.
 */
export function parseReleaseHealth(raw: unknown): ReleaseHealth | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.pulled)) return null;
  const pulled = record.pulled.filter((v): v is string => typeof v === 'string');
  const health: ReleaseHealth = { pulled };
  if (typeof record.note === 'string' && record.note.trim()) health.note = record.note.trim();
  return health;
}

/**
 * Pure decision: is `version` present in the manifest's pulled list? A null
 * manifest (unreachable / malformed) yields false — fail-open.
 */
export function isVersionPulled(version: string, health: ReleaseHealth | null): boolean {
  if (!health || !Array.isArray(health.pulled)) return false;
  const target = normalizeVersion(version);
  return health.pulled.some((entry) => normalizeVersion(entry) === target);
}

/**
 * Fetch + parse the manifest. Returns null on ANY error (network, timeout,
 * non-2xx, malformed JSON) — the caller then fails open. Runs server-side.
 */
export async function fetchReleaseHealth(
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<ReleaseHealth | null> {
  const url = opts.url ?? RELEASE_HEALTH_URL;
  const timeoutMs = opts.timeoutMs ?? 3500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    return parseReleaseHealth(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The full decision for a target version. Fetches the manifest and returns
 * whether the version is pulled (+ an optional note). Fails open: on any error
 * the result is `{ pulled: false }` and the update proceeds.
 */
export async function evaluateReleaseHealth(
  version: string,
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<ReleaseHealthDecision> {
  const health = await fetchReleaseHealth(opts);
  if (isVersionPulled(version, health)) {
    console.warn(`[app-update] version ${version} is marked pulled — skipping auto-update`);
    return { pulled: true, note: health?.note };
  }
  return { pulled: false };
}
