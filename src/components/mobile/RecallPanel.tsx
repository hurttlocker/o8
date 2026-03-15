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
    // Build query from available context
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
      if (data.error) {
        setError(data.error);
        setCards([]);
      } else {
        setCards(data.cards ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recall');
      setCards([]);
    } finally {
      setLoading(false);
    }
  }, [currentTask, cwd, branch]);

  useEffect(() => {
    if (visible) fetchRecall();
  }, [visible, fetchRecall]);

  const handleReinforce = useCallback(async (factId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reinforce', factId }),
      });
    } catch { /* non-critical */ }
  }, []);

  const handleRetire = useCallback(async (factId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', factId }),
      });
    } catch { /* non-critical */ }
  }, []);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      maxWidth: 380,
      background: '#000000',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '56px 16px 12px',
        borderBottom: '1px solid #1c1c1e',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>🧠</span>
          <span style={{ fontSize: 17, fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em' }}>
            Cortex Recall
          </span>
          {cards.length > 0 && (
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              background: '#af52de',
              color: '#fff',
              padding: '2px 7px',
              borderRadius: 10,
              minWidth: 18,
              textAlign: 'center',
            }}>
              {cards.length}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            background: '#2c2c2e',
            border: 'none',
            borderRadius: 20,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#8e8e93',
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 16px',
        WebkitOverflowScrolling: 'touch',
      }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#636366', fontSize: 13 }}>
            Searching memory…
          </div>
        )}

        {error && (
          <div style={{
            padding: '14px 16px',
            background: 'rgba(255, 59, 48, 0.08)',
            borderRadius: 12,
            borderLeft: '3px solid #ff3b30',
            color: '#ff3b30',
            fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {!loading && !error && cards.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
            <div style={{ color: '#636366', fontSize: 13 }}>
              No relevant memories found for this context.
            </div>
          </div>
        )}

        {cards.map((card) => (
          <FactCard
            key={card.id}
            fact={card}
            onReinforce={handleReinforce}
            onRetire={handleRetire}
            onInject={onInjectText}
          />
        ))}
      </div>

      {/* Footer hint */}
      {cards.length > 0 && (
        <div style={{
          padding: '10px 16px',
          borderTop: '1px solid #1c1c1e',
          fontSize: 11,
          color: '#48484a',
          textAlign: 'center',
        }}>
          Tap a card to expand · Inject to add to compose
        </div>
      )}
    </div>
  );
}
