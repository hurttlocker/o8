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

/**
 * Pre-launch memory context preview.
 * Appears above the compose bar when the user is typing a prompt.
 * Debounced search — fires 600ms after typing stops.
 */
export default function MemoryContext({
  prompt,
  cwd,
  branch,
  enabled,
  onToggle,
  onContextReady,
}: MemoryContextProps) {
  const [facts, setFacts] = useState<RecallCard[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPromptRef = useRef('');

  const fetchContext = useCallback(async (text: string) => {
    if (text.length < 10) {
      setFacts([]);
      onContextReady('');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/mobile/cortex/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, cwd, branch }),
      });
      const data = await res.json();
      setFacts(data.facts ?? []);
      if (enabled && data.contextBlock) {
        onContextReady(data.contextBlock);
      } else {
        onContextReady('');
      }
    } catch {
      setFacts([]);
      onContextReady('');
    } finally {
      setLoading(false);
    }
  }, [cwd, branch, enabled, onContextReady]);

  useEffect(() => {
    if (prompt === lastPromptRef.current) return;
    lastPromptRef.current = prompt;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchContext(prompt), 600);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [prompt, fetchContext]);

  // When toggle changes, update context block
  useEffect(() => {
    if (!enabled) {
      onContextReady('');
    }
  }, [enabled, onContextReady]);

  if (facts.length === 0 && !loading) return null;

  return (
    <div style={{
      padding: '8px 16px',
      background: '#1c1c1e',
      borderTop: '1px solid #2c2c2e',
    }}>
      {/* Header with toggle */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: loading ? 0 : 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13 }}>🧠</span>
          <span style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500 }}>
            {loading ? 'Searching memory…' : `${facts.length} relevant fact${facts.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {!loading && facts.length > 0 && (
          <button
            onClick={() => onToggle(!enabled)}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 11,
              fontWeight: 600,
              color: enabled ? '#34c759' : '#636366',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            {enabled ? '✓ Include' : 'Include'}
          </button>
        )}
      </div>

      {/* Fact pills */}
      {!loading && facts.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          opacity: enabled ? 1 : 0.5,
          transition: 'opacity 0.2s ease',
        }}>
          {facts.slice(0, 3).map((fact) => (
            <div
              key={fact.id}
              style={{
                fontSize: 11,
                lineHeight: '16px',
                color: '#e5e5ea',
                background: '#2c2c2e',
                borderRadius: 6,
                padding: '3px 8px',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ color: '#af52de', marginRight: 4 }}>
                {fact.factType === 'decision' ? '⚖️' : fact.factType === 'preference' ? '⭐' : fact.factType === 'config' ? '⚙️' : '📌'}
              </span>
              {fact.text.slice(0, 60)}
            </div>
          ))}
          {facts.length > 3 && (
            <div style={{
              fontSize: 11,
              color: '#636366',
              padding: '3px 8px',
            }}>
              +{facts.length - 3} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
