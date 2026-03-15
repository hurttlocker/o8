'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { RecallCard } from '@/lib/cortex/types';

interface MemoryContextProps {
  prompt: string;
  cwd?: string;
  branch?: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onContextReady: (contextBlock: string) => void;
}

export default function MemoryContext({
  prompt, cwd, branch, enabled, onToggle, onContextReady,
}: MemoryContextProps) {
  const [facts, setFacts] = useState<RecallCard[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPromptRef = useRef('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchContext = useCallback(async (text: string) => {
    if (text.length < 10) { setFacts([]); onContextReady(''); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/mobile/cortex/context', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, cwd, branch }),
      });
      const data = await res.json();
      if (!mountedRef.current) return;
      setFacts(data.facts ?? []);
      onContextReady(enabled && data.contextBlock ? data.contextBlock : '');
    } catch {
      if (!mountedRef.current) return;
      setFacts([]); onContextReady('');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [cwd, branch, enabled, onContextReady]);

  useEffect(() => {
    if (prompt === lastPromptRef.current) return;
    lastPromptRef.current = prompt;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchContext(prompt), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [prompt, fetchContext]);

  useEffect(() => { if (!enabled) onContextReady(''); }, [enabled, onContextReady]);

  if (facts.length === 0 && !loading) return null;

  return (
    <div style={{
      padding: '10px 20px 8px',
      background: '#1c1c1e',
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: loading ? 0 : 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>🧠</span>
          <span style={{
            fontSize: 13, color: loading ? '#48484a' : '#8e8e93',
            fontWeight: 500, letterSpacing: '-0.01em',
          }}>
            {loading ? 'Searching…' : `${facts.length} relevant`}
          </span>
        </div>
        {!loading && facts.length > 0 && (
          <button onClick={() => onToggle(!enabled)} style={{
            background: enabled ? 'rgba(52, 199, 89, 0.14)' : 'rgba(142, 142, 147, 0.1)',
            border: 'none', borderRadius: 8, padding: '5px 10px',
            fontSize: 12, fontWeight: 600,
            color: enabled ? '#34c759' : '#636366',
            cursor: 'pointer', letterSpacing: '-0.01em', minHeight: 28,
            transition: 'all 0.2s ease',
          }}>
            {enabled ? '✓ Included' : 'Include'}
          </button>
        )}
      </div>
      {!loading && facts.length > 0 && (
        <div style={{
          display: 'flex', gap: 6, overflowX: 'auto',
          WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none',
          opacity: enabled ? 1 : 0.4, transition: 'opacity 0.25s ease',
          paddingBottom: 2,
        }}>
          {facts.slice(0, 4).map((fact) => (
            <div key={fact.id} style={{
              fontSize: 12, lineHeight: '17px', color: '#d1d1d6',
              background: '#2c2c2e', borderRadius: 8, padding: '5px 10px',
              whiteSpace: 'nowrap', flexShrink: 0, maxWidth: 220,
              overflow: 'hidden', textOverflow: 'ellipsis',
              letterSpacing: '-0.01em',
            }}>
              {fact.text.slice(0, 50)}
            </div>
          ))}
          {facts.length > 4 && (
            <span style={{
              fontSize: 12, color: '#48484a', padding: '5px 8px',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              +{facts.length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
