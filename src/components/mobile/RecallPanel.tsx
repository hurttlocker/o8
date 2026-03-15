'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { RecallCard } from '@/lib/cortex/types';
import FactCard from './FactCard';

interface RecallPanelProps {
  currentTask?: string;
  cwd?: string;
  branch?: string;
  visible: boolean;
  onClose: () => void;
  onInjectText?: (text: string) => void;
}

export default function RecallPanel({
  currentTask,
  cwd,
  branch,
  visible,
  onClose,
  onInjectText,
}: RecallPanelProps) {
  const [cards, setCards] = useState<RecallCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastQueryRef = useRef<string>('');

  const fetchRecall = useCallback(async () => {
    const queryParts: string[] = [];
    if (currentTask) queryParts.push(currentTask.slice(0, 100));
    if (cwd) queryParts.push(cwd.split('/').pop() ?? '');
    if (branch) queryParts.push(branch);

    const query = queryParts.join(' ').trim();
    if (!query || query === lastQueryRef.current) return;

    lastQueryRef.current = query;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/mobile/cortex/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 6 }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); setCards([]); }
      else setCards(data.cards ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recall');
      setCards([]);
    } finally {
      setLoading(false);
    }
  }, [currentTask, cwd, branch]);

  useEffect(() => { if (visible) fetchRecall(); }, [visible, fetchRecall]);

  const handleReinforce = useCallback(async (factId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reinforce', factId }),
      });
    } catch { /* non-critical */ }
  }, []);

  const handleRetire = useCallback(async (factId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', factId }),
      });
    } catch { /* non-critical */ }
  }, []);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
      background: '#000000', zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      {/* Nav bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '60px 20px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22, lineHeight: 1 }}>🧠</span>
          <div>
            <h2 style={{
              fontSize: 20, fontWeight: 700, color: '#ffffff',
              letterSpacing: '-0.03em', margin: 0, lineHeight: '24px',
            }}>
              Recall
            </h2>
            {cards.length > 0 && (
              <span style={{
                fontSize: 12, color: '#8e8e93', fontWeight: 400,
                letterSpacing: '-0.01em',
              }}>
                {cards.length} relevant memories
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          background: '#2c2c2e', border: 'none', borderRadius: 15,
          width: 30, height: 30, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: '#aeaeb2', fontSize: 14,
          fontWeight: 700, cursor: 'pointer', minWidth: 44, minHeight: 44,
        }}>
          ✕
        </button>
      </div>

      <div style={{ height: 1, background: '#1c1c1e', margin: '0 20px' }} />

      {/* Content */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '16px 20px 32px',
        WebkitOverflowScrolling: 'touch',
      }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{
              width: 24, height: 24, margin: '0 auto 16px',
              border: '2px solid #3a3a3c', borderTopColor: '#af52de',
              borderRadius: 12, animation: 'spin 0.8s linear infinite',
            }} />
            <div style={{ color: '#636366', fontSize: 14, letterSpacing: '-0.01em' }}>
              Searching memory…
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '16px', background: 'rgba(255, 69, 58, 0.06)',
            borderRadius: 14, color: '#ff453a', fontSize: 14,
            lineHeight: '20px', letterSpacing: '-0.01em',
          }}>
            {error}
          </div>
        )}

        {!loading && !error && cards.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔍</div>
            <div style={{
              color: '#636366', fontSize: 15, lineHeight: '21px',
              letterSpacing: '-0.01em',
            }}>
              No relevant memories for this session context.
            </div>
          </div>
        )}

        {cards.map((card) => (
          <FactCard key={card.id} fact={card}
            onReinforce={handleReinforce} onRetire={handleRetire} onInject={onInjectText}
          />
        ))}
      </div>

      {cards.length > 0 && (
        <div style={{
          padding: '12px 20px 28px', borderTop: '1px solid #1c1c1e',
          fontSize: 12, color: '#3a3a3c', textAlign: 'center',
          letterSpacing: '-0.01em',
        }}>
          Tap to expand · Inject adds to compose
        </div>
      )}
    </div>
  );
}
