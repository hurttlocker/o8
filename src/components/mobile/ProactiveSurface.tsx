'use client';

/**
 * ProactiveSurface — Subtle contextual cards that surface at the top of chat.
 * "Niot just opened PR #349 on Cortex — Review?"
 * "Hawk finished QA sweep — 0 issues found"
 * "Context at 72% — compaction soon"
 *
 * These are NOT notifications (those are banners). These are persistent,
 * ambient awareness cards that stay until acted on or dismissed.
 */

import { useState, useEffect, useRef, memo, useCallback } from 'react';
import type { AgentSummary } from '@/lib/fleet/types';
import { useTheme } from './ThemeContext';

export interface ProactiveItem {
  id: string;
  type: 'pr_ready' | 'agent_done' | 'context_low' | 'build_status' | 'approval_waiting';
  title: string;
  subtitle?: string;
  actionLabel?: string;
  action?: () => void;
  color: string;
  iconPath: string;
  timestamp: number;
  dismissed?: boolean;
}

interface ProactiveSurfaceProps {
  items: ProactiveItem[];
  onDismiss: (id: string) => void;
}

const ProactiveCard = memo(function ProactiveCard({
  item, onDismiss,
}: { item: ProactiveItem; onDismiss: () => void }) {
  const { colors } = useTheme();
  const [exiting, setExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(onDismiss, 250);
  }, [onDismiss]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 14,
      background: `${item.color}06`,
      border: `1px solid ${item.color}15`,
      animation: exiting ? 'proactiveExit 250ms ease forwards' : 'proactiveEnter 350ms cubic-bezier(0.32, 0.72, 0, 1)',
      touchAction: 'manipulation',
    }}>
      {/* Icon */}
      <span style={{
        width: 28, height: 28, borderRadius: 8,
        background: `${item.color}10`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke={item.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={item.iconPath} />
        </svg>
      </span>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: colors.text,
          fontFamily: '-apple-system, system-ui, sans-serif',
          lineHeight: 1.3,
        }}>
          {item.title}
        </div>
        {item.subtitle ? (
          <div style={{ fontSize: 11, color: colors.textSecondary, marginTop: 1, lineHeight: 1.3 }}>
            {item.subtitle}
          </div>
        ) : null}
      </div>

      {/* Action button */}
      {item.actionLabel && item.action ? (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); item.action?.(); handleDismiss(); }}
          onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); item.action?.(); handleDismiss(); }}
          style={{
            padding: '5px 12px', borderRadius: 8, border: 'none',
            background: item.color, color: '#fff',
            fontSize: 11, fontWeight: 700,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
            flexShrink: 0,
          }}>
          {item.actionLabel}
        </button>
      ) : null}

      {/* Dismiss */}
      <button type="button"
        onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
        onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); handleDismiss(); }}
        style={{
          width: 20, height: 20, borderRadius: '50%',
          background: colors.surfaceBorder, border: 'none',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, padding: 0,
          WebkitTapHighlightColor: 'transparent',
          touchAction: 'manipulation',
        }}>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none"
          stroke={colors.textTertiary} strokeWidth="3" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
});

export const ProactiveSurface = memo(function ProactiveSurface({ items, onDismiss }: ProactiveSurfaceProps) {
  const visible = items.filter(i => !i.dismissed).slice(0, 3);
  if (visible.length === 0) return null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '8px 14px 4px',
    }}>
      {visible.map(item => (
        <ProactiveCard key={item.id} item={item} onDismiss={() => onDismiss(item.id)} />
      ))}
      <style>{`
        @keyframes proactiveEnter {
          from { opacity: 0; transform: translateY(-8px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes proactiveExit {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-8px) scale(0.95); }
        }
      `}</style>
    </div>
  );
});

/**
 * Hook to derive proactive items from agent state.
 */
export function useProactiveItems(
  sessions: AgentSummary[],
  onReviewPR?: (repo: string, prNumber: number) => void,
) {
  const [items, setItems] = useState<ProactiveItem[]>([]);
  const seenKeys = useRef(new Set<string>());

  useEffect(() => {
    const newItems: ProactiveItem[] = [];

    for (const s of sessions) {
      // Agent just finished
      const doneKey = `done-${s.id}-${s.currentTask}`;
      if (s.status !== 'running' && s.currentTask && !seenKeys.current.has(doneKey)) {
        seenKeys.current.add(doneKey);
        // Check if the task mentions a PR
        const prMatch = s.currentTask.match(/PR\s*#(\d+)/i);
        newItems.push({
          id: doneKey,
          type: prMatch ? 'pr_ready' : 'agent_done',
          title: `${s.name} finished`,
          subtitle: s.currentTask.slice(0, 80),
          actionLabel: prMatch ? 'Review' : undefined,
          action: prMatch && onReviewPR
            ? () => onReviewPR(s.workspace || '', parseInt(prMatch[1]))
            : undefined,
          color: prMatch ? '#af52de' : '#34c759',
          iconPath: prMatch
            ? 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3'
            : 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3',
          timestamp: Date.now(),
        });
      }

      // Context running low
      const ctx = s.context;
      if (ctx && ctx.usedPercent >= 65) {
        const ctxKey = `ctx-${s.id}-${Math.floor(ctx.usedPercent / 5) * 5}`;
        if (!seenKeys.current.has(ctxKey)) {
          seenKeys.current.add(ctxKey);
          newItems.push({
            id: ctxKey,
            type: 'context_low',
            title: `${s.name} context at ${Math.round(ctx.usedPercent)}%`,
            subtitle: 'Compaction may happen soon',
            color: ctx.usedPercent >= 80 ? '#ff3b30' : '#ff9f0a',
            iconPath: 'M12 2v10l4 4 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
            timestamp: Date.now(),
          });
        }
      }
    }

    if (newItems.length > 0) {
      setItems(prev => [...newItems, ...prev].slice(0, 10));
    }
  }, [sessions, onReviewPR]);

  const dismiss = useCallback((id: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, dismissed: true } : i));
  }, []);

  return { items, dismiss };
}
