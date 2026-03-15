'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface CortexStatusProps {
  /** Compact mode for embedding in TopBar or controls */
  compact?: boolean;
  onMemoryHealthOpen?: () => void;
  onRecallOpen?: () => void;
  onGraphOpen?: () => void;
}

interface StatusData {
  available: boolean;
  facts?: number;
  conflicts?: number;
  stale?: number;
  error?: string;
}

/**
 * Cortex availability indicator + quick-access buttons.
 *
 * Graceful degradation: if Cortex is not installed, shows an
 * informative card instead of errors. All memory surfaces
 * check availability before rendering.
 */
export default function CortexStatus({
  compact,
  onMemoryHealthOpen,
  onRecallOpen,
  onGraphOpen,
}: CortexStatusProps) {
  const [status, setStatus] = useState<StatusData | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/mobile/cortex/health');
      const data = await res.json();
      setStatus({
        available: data.available ?? false,
        facts: data.stats?.facts,
        conflicts: data.conflicts?.length,
        stale: data.staleFacts?.length,
        error: data.error,
      });
    } catch {
      setStatus({ available: false, error: 'Could not reach Cortex API' });
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  if (status === null) return null;

  // ── Compact mode: small dot + badge for TopBar ──
  if (compact) {
    if (!status.available) return null; // Don't clutter TopBar if unavailable

    const hasBadge = (status.conflicts ?? 0) > 0 || (status.stale ?? 0) > 5;

    return (
      <button
        onClick={onMemoryHealthOpen}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          position: 'relative', padding: '4px',
        }}
        title="Cortex Memory"
      >
        <span style={{ fontSize: 16 }}>🧠</span>
        {hasBadge && (
          <span style={{
            position: 'absolute', top: 0, right: 0,
            width: 8, height: 8, borderRadius: 4,
            background: (status.conflicts ?? 0) > 0 ? '#ff3b30' : '#ff9f0a',
          }} />
        )}
      </button>
    );
  }

  // ── Full mode: status card for controls sheet ──
  if (!status.available) {
    return (
      <div style={{
        background: '#1c1c1e', borderRadius: 12, padding: '16px',
        marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 18 }}>🧠</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>
            Cortex Memory
          </span>
          <span style={{
            fontSize: 10, fontWeight: 600, background: '#2c2c2e',
            color: '#636366', padding: '2px 6px', borderRadius: 4,
          }}>
            Not installed
          </span>
        </div>
        <div style={{ fontSize: 12, color: '#636366', lineHeight: '17px', marginBottom: 12 }}>
          Cortex adds persistent memory across agent sessions — decisions, preferences, and institutional knowledge that compound over time.
        </div>
        <a
          href="https://github.com/hurttlocker/cortex"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block', textAlign: 'center', padding: '8px 0',
            borderRadius: 8, background: 'rgba(175, 82, 222, 0.12)',
            color: '#af52de', fontSize: 12, fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Install Cortex →
        </a>
      </div>
    );
  }

  return (
    <div style={{
      background: '#1c1c1e', borderRadius: 12, padding: '16px',
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>🧠</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>
          Cortex Memory
        </span>
        <span style={{
          fontSize: 10, fontWeight: 600, background: 'rgba(52, 199, 89, 0.12)',
          color: '#34c759', padding: '2px 6px', borderRadius: 4,
        }}>
          Active
        </span>
        {status.facts && (
          <span style={{ fontSize: 11, color: '#636366', marginLeft: 'auto' }}>
            {status.facts >= 1000 ? `${(status.facts / 1000).toFixed(1)}k` : status.facts} facts
          </span>
        )}
      </div>

      {/* Badges */}
      {((status.conflicts ?? 0) > 0 || (status.stale ?? 0) > 0) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {(status.conflicts ?? 0) > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 500, background: 'rgba(255, 59, 48, 0.08)',
              color: '#ff3b30', padding: '3px 8px', borderRadius: 6,
            }}>
              {status.conflicts} conflict{status.conflicts !== 1 ? 's' : ''}
            </span>
          )}
          {(status.stale ?? 0) > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 500, background: 'rgba(255, 159, 10, 0.08)',
              color: '#ff9f0a', padding: '3px 8px', borderRadius: 6,
            }}>
              {status.stale} stale
            </span>
          )}
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {onRecallOpen && (
          <button
            onClick={onRecallOpen}
            style={{
              padding: '8px 0', borderRadius: 8, border: 'none',
              background: '#2c2c2e', color: '#e5e5ea',
              fontSize: 11, fontWeight: 500, cursor: 'pointer',
            }}
          >
            🔍 Recall
          </button>
        )}
        {onMemoryHealthOpen && (
          <button
            onClick={onMemoryHealthOpen}
            style={{
              padding: '8px 0', borderRadius: 8, border: 'none',
              background: '#2c2c2e', color: '#e5e5ea',
              fontSize: 11, fontWeight: 500, cursor: 'pointer',
            }}
          >
            💊 Health
          </button>
        )}
        {onGraphOpen && (
          <button
            onClick={onGraphOpen}
            style={{
              padding: '8px 0', borderRadius: 8, border: 'none',
              background: '#2c2c2e', color: '#e5e5ea',
              fontSize: 11, fontWeight: 500, cursor: 'pointer',
            }}
          >
            🕸️ Graph
          </button>
        )}
      </div>
    </div>
  );
}
