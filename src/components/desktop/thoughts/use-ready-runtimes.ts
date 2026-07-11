'use client';

import { useEffect, useState } from 'react';

/**
 * Ready worker-runtime count (Q ruling 2026-07-11).
 *
 * Drives the composer's silent solo-vs-fleet decision: one usable runtime →
 * the orchestrator runs lean/inline; two or more → fleet orchestration
 * (dispatch). Replaces the manual Fleet/Solo toggle entirely.
 *
 * The 7 CLI agent-runtime ids mirror `hasCliAgent` in /api/setup/detect. A
 * runtime counts when it's `ready` (binary + auth), falling back to `detected`
 * only when readiness is unreported. The detect probe is expensive, so it's
 * fetched ONCE per app session via a module-level cached promise and shared
 * across every composer.
 */
const RUNTIME_IDS = ['codex', 'claude-code', 'antigravity', 'opencode', 'cursor', 'grok', 'pi'];

interface DetectTool {
  id: string;
  detected?: boolean;
  ready?: boolean;
}

let cachedCount: Promise<number> | null = null;

function fetchReadyRuntimeCount(): Promise<number> {
  if (!cachedCount) {
    cachedCount = fetch('/api/setup/detect')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tools?: DetectTool[] } | null) => {
        const tools = Array.isArray(data?.tools) ? data.tools : [];
        return tools.filter((t) => RUNTIME_IDS.includes(t.id) && ((t.ready ?? t.detected) === true)).length;
      })
      .catch(() => 0);
  }
  return cachedCount;
}

/** Ready runtime count, or `null` while the one-time probe is in flight. */
export function useReadyRuntimeCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchReadyRuntimeCount().then((c) => { if (alive) setCount(c); });
    return () => { alive = false; };
  }, []);
  return count;
}
