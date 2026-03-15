'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Brain, X, Loader2 } from 'lucide-react';
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
  currentTask, cwd, branch, visible, onClose, onInjectText,
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
    setLoading(true); setError(null);
    try {
      const data = await (await fetch('/api/mobile/cortex/recall', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 6 }),
      })).json();
      if (data.error) { setError(data.error); setCards([]); }
      else setCards(data.cards ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recall');
      setCards([]);
    } finally { setLoading(false); }
  }, [currentTask, cwd, branch]);

  useEffect(() => { if (visible) fetchRecall(); }, [visible, fetchRecall]);

  const handleReinforce = useCallback(async (factId: number) => {
    try { await fetch('/api/mobile/cortex/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reinforce', factId }) }); } catch {}
  }, []);

  const handleRetire = useCallback(async (factId: number) => {
    try { await fetch('/api/mobile/cortex/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retire', factId }) }); } catch {}
  }, []);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
      background: 'linear-gradient(180deg, #fbfcff 0%, #f5f7fb 100%)',
      zIndex: 1000, display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      {/* Nav */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '60px 20px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 12,
            background: 'var(--blue-soft, rgba(37, 99, 235, 0.12))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--blue, #2563eb)',
          }}>
            <Brain size={20} strokeWidth={1.8} />
          </div>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111827', letterSpacing: '-0.02em', margin: 0 }}>
              Recall
            </h2>
            {cards.length > 0 && (
              <span style={{ fontSize: 12, color: '#5b6475', fontWeight: 400 }}>
                {cards.length} relevant memories
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          background: 'rgba(15, 23, 42, 0.05)', border: 'none', borderRadius: 12,
          width: 32, height: 32, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: '#64748b', cursor: 'pointer',
          minWidth: 44, minHeight: 44,
        }}>
          <X size={16} strokeWidth={2.2} />
        </button>
      </div>

      <div style={{ height: 1, background: 'rgba(15, 23, 42, 0.06)', margin: '0 20px' }} />

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 32px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Loader2 size={24} strokeWidth={2} style={{ margin: '0 auto 16px', color: '#2563eb', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: '#5b6475', fontSize: 14 }}>Searching memory…</div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '16px', background: 'rgba(220, 38, 38, 0.06)', borderRadius: 14,
            border: '1px solid rgba(220, 38, 38, 0.12)', color: '#dc2626', fontSize: 14,
          }}>{error}</div>
        )}

        {!loading && !error && cards.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <Brain size={40} strokeWidth={1.2} style={{ color: '#cbd5e1', margin: '0 auto 16px', display: 'block' }} />
            <div style={{ color: '#5b6475', fontSize: 15, lineHeight: '21px' }}>
              No relevant memories for this session context.
            </div>
          </div>
        )}

        {cards.map((card) => (
          <FactCard key={card.id} fact={card}
            onReinforce={handleReinforce} onRetire={handleRetire} onInject={onInjectText} />
        ))}
      </div>

      {cards.length > 0 && (
        <div style={{
          padding: '12px 20px 28px', borderTop: '1px solid rgba(15, 23, 42, 0.06)',
          fontSize: 12, color: '#94a3b8', textAlign: 'center',
        }}>
          Tap to expand · Inject adds to compose
        </div>
      )}
    </div>
  );
}
