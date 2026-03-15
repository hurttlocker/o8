'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface CortexStatusProps {
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

export default function CortexStatus({
  compact, onMemoryHealthOpen, onRecallOpen, onGraphOpen,
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

  useEffect(() => { checkStatus(); }, [checkStatus]);

  if (status === null) return null;

  if (compact) {
    if (!status.available) return null;
    const hasBadge = (status.conflicts ?? 0) > 0 || (status.stale ?? 0) > 5;
    return (
      <button onClick={onMemoryHealthOpen} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        position: 'relative', padding: 4, minWidth: 44, minHeight: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>🧠</span>
        {hasBadge && <span style={{
          position: 'absolute', top: 6, right: 6, width: 8, height: 8,
          borderRadius: 4, background: (status.conflicts ?? 0) > 0 ? '#ff453a' : '#ff9f0a',
          boxShadow: '0 0 0 2px #000000',
        }} />}
      </button>
    );
  }

  if (!status.available) {
    return (
      <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '20px', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 22, lineHeight: 1 }}>🧠</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em' }}>
              Cortex Memory
            </div>
            <div style={{ fontSize: 12, color: '#48484a', fontWeight: 500 }}>Not installed</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: '#636366', lineHeight: '19px', letterSpacing: '-0.01em', marginBottom: 16 }}>
          Persistent memory across agent sessions — decisions, preferences, and knowledge that compounds over time.
        </div>
        <a href="https://github.com/hurttlocker/cortex" target="_blank" rel="noopener noreferrer" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 0',
          borderRadius: 12, background: 'rgba(175, 82, 222, 0.1)', color: '#af52de',
          fontSize: 14, fontWeight: 600, textDecoration: 'none', letterSpacing: '-0.01em', minHeight: 44,
        }}>
          Install Cortex
        </a>
      </div>
    );
  }

  const formattedFacts = (status.facts ?? 0) >= 1000 ? `${((status.facts ?? 0) / 1000).toFixed(1)}k` : String(status.facts ?? 0);

  return (
    <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '20px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>🧠</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em', lineHeight: '20px' }}>
            Cortex Memory
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 12, color: '#34c759', fontWeight: 500 }}>Active</span>
            <span style={{ fontSize: 12, color: '#3a3a3c' }}>·</span>
            <span style={{ fontSize: 12, color: '#48484a', fontVariantNumeric: 'tabular-nums' }}>{formattedFacts} facts</span>
          </div>
        </div>
      </div>
      {((status.conflicts ?? 0) > 0 || (status.stale ?? 0) > 0) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {(status.conflicts ?? 0) > 0 && (
            <span style={{ fontSize: 12, fontWeight: 500, background: 'rgba(255, 69, 58, 0.08)', color: '#ff453a', padding: '4px 10px', borderRadius: 8 }}>
              {status.conflicts} conflict{status.conflicts !== 1 ? 's' : ''}
            </span>
          )}
          {(status.stale ?? 0) > 0 && (
            <span style={{ fontSize: 12, fontWeight: 500, background: 'rgba(255, 159, 10, 0.08)', color: '#ff9f0a', padding: '4px 10px', borderRadius: 8 }}>
              {status.stale} stale
            </span>
          )}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        {onRecallOpen && (
          <button onClick={onRecallOpen} style={{
            padding: '12px 0', borderRadius: 12, border: 'none', background: '#2c2c2e', color: '#f2f2f7',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
          }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>🔍</span><span>Recall</span>
          </button>
        )}
        {onMemoryHealthOpen && (
          <button onClick={onMemoryHealthOpen} style={{
            padding: '12px 0', borderRadius: 12, border: 'none', background: '#2c2c2e', color: '#f2f2f7',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
          }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>📊</span><span>Health</span>
          </button>
        )}
        {onGraphOpen && (
          <button onClick={onGraphOpen} style={{
            padding: '12px 0', borderRadius: 12, border: 'none', background: '#2c2c2e', color: '#f2f2f7',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
          }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>🕸️</span><span>Graph</span>
          </button>
        )}
      </div>
    </div>
  );
}
