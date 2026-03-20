'use client';

import React, { useState, useEffect } from 'react';
import { Brain, Search, Activity, GitBranch, ExternalLink, AlertTriangle } from 'lucide-react';

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

export default function CortexStatus({ compact, onMemoryHealthOpen, onRecallOpen, onGraphOpen }: CortexStatusProps) {
  const [status, setStatus] = useState<StatusData | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkStatus() {
      try {
        const res = await fetch('/api/mobile/cortex/health');
        const data = await res.json();
        if (cancelled) return;
        setStatus({
          available: data.available ?? false,
          facts: data.stats?.facts,
          conflicts: data.conflicts?.length,
          stale: data.staleFacts?.length,
          error: data.error,
        });
      } catch {
        if (!cancelled) {
          setStatus({ available: false, error: 'Could not reach Cortex API' });
        }
      }
    }

    void checkStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === null) return null;

  if (compact) {
    if (!status.available) return null;
    const hasBadge = (status.conflicts ?? 0) > 0 || (status.stale ?? 0) > 5;
    return (
      <button onClick={onMemoryHealthOpen} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        position: 'relative', padding: 4, minWidth: 44, minHeight: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#2563eb',
      }}>
        <Brain size={18} strokeWidth={1.8} />
        {hasBadge && <span style={{
          position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: 4,
          background: (status.conflicts ?? 0) > 0 ? '#dc2626' : '#b45309',
          boxShadow: '0 0 0 2px #ffffff',
        }} />}
      </button>
    );
  }

  if (!status.available) {
    return (
      <div style={{
        background: 'rgba(255, 255, 255, 0.82)', border: '1px solid rgba(15, 23, 42, 0.08)',
        borderRadius: 16, padding: '20px', marginBottom: 12,
        boxShadow: '0 2px 8px rgba(15, 23, 42, 0.04)', backdropFilter: 'blur(12px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 12,
            background: 'rgba(15, 23, 42, 0.04)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', color: '#94a3b8',
          }}>
            <Brain size={20} strokeWidth={1.8} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>Cortex Memory</div>
            <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 500 }}>Not installed</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: '#5b6475', lineHeight: '19px', marginBottom: 16 }}>
          Persistent memory across agent sessions — decisions, preferences, and knowledge that compounds over time.
        </div>
        <a href="https://github.com/hurttlocker/cortex" target="_blank" rel="noopener noreferrer" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '12px 0', borderRadius: 12, background: 'rgba(37, 99, 235, 0.08)',
          color: '#2563eb', fontSize: 14, fontWeight: 600, textDecoration: 'none', minHeight: 44,
          border: '1px solid rgba(37, 99, 235, 0.12)',
        }}>
          <ExternalLink size={15} /> Install Cortex
        </a>
      </div>
    );
  }

  const formattedFacts = (status.facts ?? 0) >= 1000 ? `${((status.facts ?? 0) / 1000).toFixed(1)}k` : String(status.facts ?? 0);

  return (
    <div style={{
      background: 'rgba(255, 255, 255, 0.82)', border: '1px solid rgba(15, 23, 42, 0.08)',
      borderRadius: 16, padding: '20px', marginBottom: 12,
      boxShadow: '0 2px 8px rgba(15, 23, 42, 0.04)', backdropFilter: 'blur(12px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 12,
          background: 'var(--blue-soft, rgba(37, 99, 235, 0.12))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--blue, #2563eb)',
        }}>
          <Brain size={20} strokeWidth={1.8} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#111827', lineHeight: '20px' }}>Cortex Memory</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 12, color: '#059669', fontWeight: 500 }}>Active</span>
            <span style={{ fontSize: 12, color: '#cbd5e1' }}>·</span>
            <span style={{ fontSize: 12, color: '#5b6475', fontVariantNumeric: 'tabular-nums' }}>{formattedFacts} facts</span>
          </div>
        </div>
      </div>

      {((status.conflicts ?? 0) > 0 || (status.stale ?? 0) > 0) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {(status.conflicts ?? 0) > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, background: 'rgba(220, 38, 38, 0.06)', color: '#dc2626', padding: '4px 10px', borderRadius: 8, border: '1px solid rgba(220, 38, 38, 0.1)' }}>
              <AlertTriangle size={12} /> {status.conflicts} conflict{status.conflicts !== 1 ? 's' : ''}
            </span>
          )}
          {(status.stale ?? 0) > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 500, background: 'rgba(180, 83, 9, 0.06)', color: '#b45309', padding: '4px 10px', borderRadius: 8, border: '1px solid rgba(180, 83, 9, 0.1)' }}>
              {status.stale} stale
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {onRecallOpen && (
          <button onClick={onRecallOpen} style={{
            padding: '10px 0', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.06)',
            background: 'rgba(255, 255, 255, 0.9)', color: '#111827',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}>
            <Search size={16} strokeWidth={1.8} style={{ color: '#2563eb' }} />
            <span>Recall</span>
          </button>
        )}
        {onMemoryHealthOpen && (
          <button onClick={onMemoryHealthOpen} style={{
            padding: '10px 0', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.06)',
            background: 'rgba(255, 255, 255, 0.9)', color: '#111827',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}>
            <Activity size={16} strokeWidth={1.8} style={{ color: '#059669' }} />
            <span>Health</span>
          </button>
        )}
        {onGraphOpen && (
          <button onClick={onGraphOpen} style={{
            padding: '10px 0', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.06)',
            background: 'rgba(255, 255, 255, 0.9)', color: '#111827',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}>
            <GitBranch size={16} strokeWidth={1.8} style={{ color: '#7c3aed' }} />
            <span>Graph</span>
          </button>
        )}
      </div>
    </div>
  );
}
