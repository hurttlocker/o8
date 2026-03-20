'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Brain } from 'lucide-react';
import type { RecallCard } from '@/lib/cortex/types';

interface MemoryContextProps {
  prompt: string;
  cwd?: string;
  branch?: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onContextReady: (contextBlock: string) => void;
  onOpenRecall?: () => void;
}

export default function MemoryContext({
  prompt, cwd, branch, enabled, onToggle, onContextReady, onOpenRecall,
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

  // Always show recall button, even when no facts
  const showFacts = facts.length > 0 && !loading;

  return (
    <div style={{
      padding: '8px 16px',
      background: 'rgba(255, 255, 255, 0.72)',
      borderTop: '1px solid rgba(15, 23, 42, 0.06)',
      backdropFilter: 'blur(16px)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      {/* Recall button — always visible */}
      {onOpenRecall && (
        <button onClick={onOpenRecall} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, borderRadius: 10, border: 'none',
          background: 'var(--blue-soft, rgba(37, 99, 235, 0.12))',
          color: 'var(--blue, #2563eb)',
          cursor: 'pointer', flexShrink: 0, padding: 0,
          minWidth: 44, minHeight: 44,
        }} aria-label="Open Memory Recall">
          <Brain size={17} strokeWidth={2} />
        </button>
      )}

      {/* Context status */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {loading && (
          <span style={{ fontSize: 12, color: 'var(--muted, #5b6475)', fontWeight: 500, letterSpacing: '-0.01em' }}>
            Searching…
          </span>
        )}
        {showFacts && (
          <div style={{
            display: 'flex', gap: 5, overflow: 'hidden', flex: 1,
          }}>
            {facts.slice(0, 3).map((fact) => (
              <span key={fact.id} style={{
                fontSize: 11, lineHeight: '16px', color: 'var(--text, #111827)',
                background: 'rgba(15, 23, 42, 0.04)',
                borderRadius: 6, padding: '3px 8px',
                whiteSpace: 'nowrap', flexShrink: 0, maxWidth: 160,
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {fact.text.slice(0, 40)}
              </span>
            ))}
            {facts.length > 3 && (
              <span style={{ fontSize: 11, color: 'var(--muted, #5b6475)', padding: '3px 4px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                +{facts.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Toggle */}
      {showFacts && (
        <button onClick={() => onToggle(!enabled)} style={{
          background: enabled ? 'rgba(5, 150, 105, 0.1)' : 'rgba(15, 23, 42, 0.04)',
          border: 'none', borderRadius: 7, padding: '4px 9px',
          fontSize: 11, fontWeight: 600,
          color: enabled ? 'var(--green, #059669)' : 'var(--muted, #5b6475)',
          cursor: 'pointer', letterSpacing: '-0.01em',
          whiteSpace: 'nowrap', flexShrink: 0,
          transition: 'all 0.2s ease',
        }}>
          {enabled ? '✓ On' : 'Off'}
        </button>
      )}
    </div>
  );
}
