'use client';

/**
 * OrchestratorEmptyState — the curated landing view for the Orchestrator
 * tab when it has no messages yet.
 *
 * Two-column "Let's get building" layout (#888/#889):
 *   - LEFT  — greeting + 4 quick-action cards (existing pattern).
 *   - RIGHT — repo-grouped recent-work cards from the lanes table, with
 *             status dots + relative timestamps. GROUPED BY REPO and
 *             SHOW ARCHIVED toggles in the header. Click a card to
 *             expand its packet in the mission rail.
 *
 * Style: paper-and-ink Rams, Issues-style uppercase labels, one orange
 * accent (status dot for `done` lanes). Inline styles only, theme
 * tokens, no native form controls.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { Lane, LaneStatus } from '@/lib/lane/types';

interface QuickAction {
  id: string;
  label: string;
  detail: string;
  prompt: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'whats-active',
    label: "What's active right now?",
    detail: 'Live fleet status, running sessions, blockers',
    prompt: 'Give me a snapshot of every active agent session right now — what runtime, what task, what status, and what needs my attention.',
  },
  {
    id: 'review-pending',
    label: 'Review pending changes',
    detail: 'Diffs waiting for approval across lanes',
    prompt: 'Walk me through every pending diff waiting for approval. For each one: what repo, what the agent changed, and whether it looks safe to merge.',
  },
  {
    id: 'ship-status',
    label: 'What shipped today?',
    detail: 'Merged work and momentum across agents',
    prompt: 'Summarize everything that merged into main today across all agents. Group by repo, highlight anything risky, and tell me the overall momentum.',
  },
  {
    id: 'dispatch',
    label: 'Dispatch a task',
    detail: 'Scope and route work to an agent',
    prompt: 'Help me scope a task to dispatch. Ask me what repo and what needs to happen, then draft a tight, one-paragraph task packet I can send.',
  },
];

const GROUPED_KEY = 'cortex-ide:orchestrator:empty:grouped';
const ARCHIVED_KEY = 'cortex-ide:orchestrator:empty:show-archived';

type LaneSummary = Pick<Lane, 'id' | 'label' | 'repoPath' | 'branch' | 'runtime' | 'status' | 'updatedAt' | 'lastEventAt' | 'packetId'>;

type RecentSectionId = 'needs-you' | 'in-flight' | 'done-today';

interface OrchestratorEmptyStateProps {
  greeting: string;
  runtimeLabel: string;
  onActionClick: (prompt: string) => void;
  /** Per-section click routing for Recent Work rows. Section id tells the
   *  caller the operator's intent: review (needs-you), watch (in-flight),
   *  or recap (done-today). */
  onActivateLane?: (
    lane: { id: string; sessionKey?: string | null; packetId?: string | null; status: string },
    sectionId: RecentSectionId,
  ) => void;
  /** Hide the Recent Work column. Default true; OrchestratorTab passes
   *  false when the Mission rail is open since the same packets render
   *  there. */
  showRecentWork?: boolean;
}

function readBoolPref(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBoolPref(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

function repoBaseName(repoPath: string): string {
  const cleaned = repoPath.replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return parts[parts.length - 1] || repoPath;
}

function formatRelativeShort(input: string | null | undefined): string {
  if (!input) return '';
  const ts = Date.parse(input);
  if (Number.isNaN(ts)) return '';
  const delta = Date.now() - ts;
  if (delta < 0) return 'now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}

/**
 * Status dot derivation per #889 acceptance criteria:
 *   filled-orange — done (completed lanes)
 *   half-filled   — in-progress (running, launching, awaiting_input, paused)
 *   hollow        — not started or idle
 */
type StatusDotKind = 'done' | 'in-progress' | 'idle';

function statusDotKind(status: LaneStatus): StatusDotKind {
  if (status === 'completed' || status === 'archived') return 'done';
  if (status === 'idle') return 'idle';
  return 'in-progress';
}

function StatusDot({ kind }: { kind: StatusDotKind }) {
  const orange = '#FF5A1F';
  const muted = 'var(--t-text-faint, #94a3b8)';
  if (kind === 'done') {
    return <span aria-hidden style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: orange, flexShrink: 0 }} />;
  }
  if (kind === 'in-progress') {
    return (
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: `linear-gradient(90deg, ${orange} 0% 50%, transparent 50% 100%)`,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: orange,
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: 'transparent',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: muted,
        flexShrink: 0,
      }}
    />
  );
}

function OrchestratorEmptyStateBase({
  greeting,
  runtimeLabel,
  onActionClick,
  onActivateLane,
  showRecentWork = true,
}: OrchestratorEmptyStateProps) {
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [groupedByRepo, setGroupedByRepo] = useState<boolean>(() => readBoolPref(GROUPED_KEY, true));
  const [showArchived, setShowArchived] = useState<boolean>(() => readBoolPref(ARCHIVED_KEY, false));

  const fetchLanes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/lanes?active=false', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as { lanes?: LaneSummary[] };
      const list = (data.lanes ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setLanes(list);
    } catch {
      // silent — best effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLanes();
  }, [fetchLanes]);

  const filtered = useMemo(() => {
    const list = lanes.filter((lane) => showArchived ? true : lane.status !== 'archived');
    return list.slice(0, 24);
  }, [lanes, showArchived]);

  // Status-anchored sectioning. Each lane lands in exactly one of three
  // buckets ordered by operator urgency: action-required first,
  // observe-only next, recap last. DONE is capped to 24h unless the
  // archived toggle is on, so the column doesn't become a graveyard.
  const sections = useMemo(() => {
    const needsYou: LaneSummary[] = [];
    const inFlight: LaneSummary[] = [];
    const doneToday: LaneSummary[] = [];
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const lane of filtered) {
      const status = lane.status;
      if (status === 'reviewing' || status === 'awaiting_input') {
        needsYou.push(lane);
      } else if (status === 'running' || status === 'launching' || status === 'merging' || status === 'paused') {
        inFlight.push(lane);
      } else if (status === 'completed' || status === 'archived' || status === 'idle') {
        const ts = lane.updatedAt ? new Date(lane.updatedAt).getTime() : 0;
        if (showArchived || (ts && now - ts < dayMs)) {
          doneToday.push(lane);
        }
      }
    }
    const buildGrouping = (laneList: LaneSummary[]) => {
      if (!groupedByRepo) {
        return [{ repoLabel: 'All repos', lanes: laneList }];
      }
      const map = new Map<string, LaneSummary[]>();
      for (const lane of laneList) {
        const key = repoBaseName(lane.repoPath);
        const bucket = map.get(key);
        if (bucket) bucket.push(lane);
        else map.set(key, [lane]);
      }
      return Array.from(map.entries()).map(([repoLabel, bucket]) => ({ repoLabel, lanes: bucket }));
    };
    return [
      { id: 'needs-you' as const, label: 'Needs you', accentColor: '#FF5A1F', dotColor: '#FF5A1F', lanes: needsYou, groups: buildGrouping(needsYou) },
      { id: 'in-flight' as const, label: 'In flight', accentColor: 'var(--t-text-secondary)', dotColor: '#22c55e', lanes: inFlight, groups: buildGrouping(inFlight) },
      { id: 'done-today' as const, label: showArchived ? 'Done' : 'Done today', accentColor: 'var(--t-text-faint)', dotColor: 'var(--t-text-faint)', lanes: doneToday, groups: buildGrouping(doneToday) },
    ];
  }, [filtered, groupedByRepo, showArchived]);

  const totalLanes = sections.reduce((sum, s) => sum + s.lanes.length, 0);

  const handleToggleGrouped = useCallback(() => {
    setGroupedByRepo((prev) => {
      const next = !prev;
      writeBoolPref(GROUPED_KEY, next);
      return next;
    });
  }, []);

  const handleToggleArchived = useCallback(() => {
    setShowArchived((prev) => {
      const next = !prev;
      writeBoolPref(ARCHIVED_KEY, next);
      return next;
    });
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        flex: 1,
        minHeight: 0,
        gap: 24,
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
      }}
    >
      {/* LEFT — greeting + quick actions */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 28,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <div
            style={{
              fontSize: 34,
              fontWeight: 300,
              color: 'var(--t-text-secondary)',
              letterSpacing: '-0.03em',
              lineHeight: 1.15,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              textAlign: 'center',
            }}
          >
            Let&rsquo;s get building.
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            {greeting}
          </div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-muted)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginTop: 4,
            }}
          >
            {runtimeLabel}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))',
            gap: 10,
            width: '100%',
            maxWidth: 480,
          }}
        >
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onActionClick(action.prompt)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 4,
                paddingTop: 12,
                paddingRight: 14,
                paddingBottom: 12,
                paddingLeft: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 120ms cubic-bezier(0.22, 1, 0.36, 1), background 120ms cubic-bezier(0.22, 1, 0.36, 1), transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                minHeight: 60,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--t-accent-border)';
                e.currentTarget.style.background = 'var(--t-panel-hover)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
                e.currentTarget.style.background = 'var(--t-bg-card)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.3,
                }}
              >
                {action.label}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: 'var(--t-text-muted)',
                  lineHeight: 1.4,
                }}
              >
                {action.detail}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* RIGHT — repo-grouped recent work (hidden when Mission rail is open
          to avoid double-rendering the same packets) */}
      {showRecentWork ? (
      <div
        style={{
          width: 320,
          minWidth: 280,
          maxWidth: 360,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minHeight: 0,
        }}
      >
        {/* Header — toggles */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 4,
            paddingBottom: 6,
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: 'var(--t-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
          >
            Recent work
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ToggleChip active={groupedByRepo} label="Grouped" onClick={handleToggleGrouped} title="Group by repo" />
            <ToggleChip active={showArchived} label="Archived" onClick={handleToggleArchived} title="Show archived" />
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {loading && totalLanes === 0 ? (
            <div
              style={{
                fontSize: 11,
                color: 'var(--t-text-muted)',
                paddingTop: 12,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              Loading…
            </div>
          ) : totalLanes === 0 ? (
            <div
              style={{
                fontSize: 11,
                color: 'var(--t-text-muted)',
                paddingTop: 12,
                lineHeight: 1.55,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              }}
            >
              No recent work yet. Dispatched packets will appear here.
            </div>
          ) : (
            sections
              .filter((section) => section.lanes.length > 0)
              .map((section) => (
                <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingBottom: 2,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{ width: 5, height: 5, borderRadius: 999, background: section.dotColor, flexShrink: 0 }}
                    />
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        color: section.accentColor,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                      }}
                    >
                      {section.label}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: 'var(--t-text-faint)',
                        fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                      }}
                    >
                      {section.lanes.length}
                    </span>
                  </div>
                  {section.groups.map((group) => (
                    <div key={`${section.id}:${group.repoLabel}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {groupedByRepo ? (
                        <div
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            color: 'var(--t-text-faint)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                            paddingTop: 2,
                          }}
                        >
                          {group.repoLabel}
                        </div>
                      ) : null}
                      {group.lanes.map((lane) => (
                        <RecentLaneRow
                          key={lane.id}
                          lane={lane}
                          onActivate={onActivateLane ? () => onActivateLane(lane, section.id) : undefined}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ))
          )}
        </div>
      </div>
      ) : null}
    </div>
  );
}

function ToggleChip({ active, label, onClick, title }: { active: boolean; label: string; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        height: 22,
        paddingTop: 0,
        paddingRight: 8,
        paddingBottom: 0,
        paddingLeft: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        fontSize: 9,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        cursor: 'pointer',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {label}
    </button>
  );
}

interface RecentLaneRowProps {
  lane: LaneSummary;
  onActivate?: () => void;
}

function RecentLaneRow({ lane, onActivate }: RecentLaneRowProps) {
  const dotKind = statusDotKind(lane.status);
  const stamp = formatRelativeShort(lane.lastEventAt ?? lane.updatedAt);
  const handleClick = useCallback(() => {
    if (onActivate) onActivate();
  }, [onActivate]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!onActivate}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 6,
        paddingRight: 8,
        paddingBottom: 6,
        paddingLeft: 8,
        borderRadius: 8,
        borderWidth: 0,
        background: 'transparent',
        cursor: onActivate ? 'pointer' : 'default',
        textAlign: 'left',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
      onMouseEnter={(e) => {
        if (!onActivate) return;
        e.currentTarget.style.background = 'var(--t-panel-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <StatusDot kind={dotKind} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: 500,
          color: 'var(--t-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: '-0.005em',
        }}
      >
        {lane.label}
      </span>
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          color: 'var(--t-text-muted)',
          fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
        }}
      >
        {stamp}
      </span>
    </button>
  );
}

export const OrchestratorEmptyState = memo(OrchestratorEmptyStateBase);

export function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}
