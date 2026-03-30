'use client';

import { useState, useEffect, useCallback } from 'react';

// ── Types ──

interface CortexConfig {
  embedModel: string;
  enrichModel: string;
  classifyModel: string;
  expandModel: string;
  llmProvider: string;
  llmApiKey: string;
  llmApiKeySet: boolean;
  configPath: string;
  dbPath: string;
  sourceBoostCount: number;
  recallEnabled?: boolean;
  recallMaxResults?: number;
  recallTokenBudget?: number;
  recallMinConfidence?: number;
}

interface CortexStats {
  memories: number;
  facts: number;
  sources: number;
  storageMb: string;
  avgConfidence: string;
  embeddings: number;
  embedCoverage: string;
  factsByType: Record<string, number>;
  confidenceDistribution: Record<string, number>;
  growth: Record<string, number>;
}

interface ConflictFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source: string;
  lastSeen?: string;
  factType?: string;
}

interface ConflictPair {
  factA: ConflictFact;
  factB: ConflictFact;
}

// ── Conflict Helpers ──

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readConflictString(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function readConflictNumber(record: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function normalizeNestedConflictFact(value: unknown): ConflictFact | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = readConflictNumber(record, ['ID', 'id']);
  const subject = readConflictString(record, ['Subject', 'subject']);
  const predicate = readConflictString(record, ['Predicate', 'predicate']);
  const object = readConflictString(record, ['Object', 'object']);

  if (!id || !subject || !predicate || !object) return null;

  return {
    id,
    subject,
    predicate,
    object,
    confidence: readConflictNumber(record, ['Confidence', 'confidence'], 0),
    source: readConflictString(record, ['Source', 'source', 'SourceQuote', 'sourceQuote'], 'unknown'),
    lastSeen: readConflictString(record, ['LastReinforced', 'lastSeen', 'last_seen', 'CreatedAt', 'created_at']) || undefined,
    factType: readConflictString(record, ['FactType', 'factType', 'fact_type']) || undefined,
  };
}

function normalizeFlatConflictFact(record: Record<string, unknown>, prefix: 'fact_a' | 'fact_b'): ConflictFact | null {
  const id = readConflictNumber(record, [`${prefix}_id`, `${prefix}Id`]);
  const subject = readConflictString(record, [`${prefix}_subject`, `${prefix}Subject`]);
  const predicate = readConflictString(record, [`${prefix}_predicate`, `${prefix}Predicate`]);
  const object = readConflictString(record, [`${prefix}_object`, `${prefix}Object`]);

  if (!id || !subject || !predicate || !object) return null;

  return {
    id,
    subject,
    predicate,
    object,
    confidence: readConflictNumber(record, [`${prefix}_confidence`, `${prefix}Confidence`], 0),
    source: readConflictString(record, [`${prefix}_source`, `${prefix}_source_quote`, `${prefix}Source`, `${prefix}SourceQuote`], 'unknown'),
    lastSeen: readConflictString(record, [`${prefix}_last_seen`, `${prefix}_last_reinforced`, `${prefix}LastSeen`, `${prefix}LastReinforced`, `${prefix}_created_at`]) || undefined,
    factType: readConflictString(record, [`${prefix}_fact_type`, `${prefix}FactType`]) || undefined,
  };
}

function parseConflictPairs(result: unknown): ConflictPair[] {
  if (!Array.isArray(result)) return [];

  return result.flatMap((entry): ConflictPair[] => {
    const record = asRecord(entry);
    if (!record) return [];

    const factA =
      normalizeNestedConflictFact(record['fact1']) ??
      normalizeNestedConflictFact(record['factA']) ??
      normalizeFlatConflictFact(record, 'fact_a');

    const factB =
      normalizeNestedConflictFact(record['fact2']) ??
      normalizeNestedConflictFact(record['factB']) ??
      normalizeFlatConflictFact(record, 'fact_b');

    return factA && factB ? [{ factA, factB }] : [];
  });
}

function formatConflictDate(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Stat Card ──

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      paddingRight: 16,
      background: 'var(--t-bg-card, #f8fafc)',
      borderRadius: 12,
      border: '1px solid var(--t-border, #e2e8f0)',
    }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--t-text, #0f172a)', letterSpacing: '-0.02em' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Cortex Memory Tab ──

export function CortexMemoryTab() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<CortexConfig | null>(null);
  const [stats, setStats] = useState<CortexStats | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [healthy, setHealthy] = useState(false);
  const [doctorSummary, setDoctorSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [actionRunning, setActionRunning] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictPair[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [resolving, setResolving] = useState<number | null>(null);
  const [conflictsChecked, setConflictsChecked] = useState(false);
  const [conflictError, setConflictError] = useState('');
  const [conflictToast, setConflictToast] = useState('');

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/cortex/config');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setConfig(data.config || null);
      setStats(data.stats || null);
      setOllamaModels(data.ollamaModels || []);
      setVersion(data.version || 'unknown');
      setHealthy(data.healthy ?? false);
      setDoctorSummary(data.doctorSummary || '');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async (updates: Partial<CortexConfig>) => {
    setSaving(true);
    setSaveNote('');
    try {
      const res = await fetch('/api/v2/cortex/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(''), 2000);
      void loadConfig();
    } catch {
      setSaveNote('Error saving');
    } finally {
      setSaving(false);
    }
  }, [loadConfig]);

  useEffect(() => {
    if (!conflictToast) return;
    const timeout = setTimeout(() => setConflictToast(''), 2200);
    return () => clearTimeout(timeout);
  }, [conflictToast]);

  const checkConflicts = useCallback(async () => {
    setConflictsChecked(true);
    setConflictsLoading(true);
    setConflictError('');

    try {
      const params = new URLSearchParams({ command: 'conflicts --json --limit 20' });
      const res = await fetch(`/api/v2/cortex/action?${params.toString()}`, {
        method: 'GET',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({} as { ok?: boolean; result?: unknown; error?: string }));

      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Unable to load conflicts');
      }

      setConflicts(parseConflictPairs(data.result));
    } catch (err) {
      setConflicts([]);
      setConflictError(err instanceof Error ? err.message : 'Unable to load conflicts');
    } finally {
      setConflictsLoading(false);
    }
  }, []);

  const resolveConflict = useCallback(async (keepId: number, dropId: number) => {
    setResolving(keepId);
    setConflictError('');

    try {
      const keepRes = await fetch('/api/v2/cortex/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `fact keep ${keepId}` }),
      });
      const keepData = await keepRes.json().catch(() => ({} as { ok?: boolean; error?: string }));
      if (!keepRes.ok || keepData.ok === false) {
        throw new Error(keepData.error || 'Failed to keep fact');
      }

      const dropRes = await fetch('/api/v2/cortex/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `fact drop ${dropId}` }),
      });
      const dropData = await dropRes.json().catch(() => ({} as { ok?: boolean; error?: string }));
      if (!dropRes.ok || dropData.ok === false) {
        throw new Error(dropData.error || 'Failed to drop fact');
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 220));
      setConflicts((current) => current.filter((pair) => (
        pair.factA.id !== keepId
        && pair.factB.id !== keepId
        && pair.factA.id !== dropId
        && pair.factB.id !== dropId
      )));
      setConflictToast('✓ Resolved');
      void loadConfig();
    } catch (err) {
      setConflictError(err instanceof Error ? err.message : 'Unable to resolve conflict');
    } finally {
      setResolving(null);
    }
  }, [loadConfig]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--t-text-muted, #94a3b8)' }}>
        Loading Cortex configuration…
      </div>
    );
  }

  const recallEnabled = config?.recallEnabled ?? true;
  const recallMaxResults = config?.recallMaxResults ?? 7;
  const recallTokenBudget = config?.recallTokenBudget ?? 800;
  const recallMinConfidence = config?.recallMinConfidence ?? 0.3;

  return (
    <div style={{
      paddingTop: 32,
      paddingBottom: 32,
      paddingLeft: 40,
      paddingRight: 40,
      maxWidth: 680,
      fontFamily: '-apple-system, system-ui, sans-serif',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--t-text, #0f172a)', margin: 0 }}>
            Cortex Memory
          </h2>
          <span style={{
            fontSize: 11,
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 6,
            background: healthy ? 'rgba(52,211,153,0.1)' : 'rgba(239,68,68,0.1)',
            color: healthy ? '#10b981' : '#ef4444',
            fontWeight: 600,
          }}>
            {healthy ? '● Healthy' : '● Unhealthy'}
          </span>
          {version && (
            <span style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>v{version.replace('cortex ', '')}</span>
          )}
        </div>
        <p style={{ fontSize: 13, color: 'var(--t-text-muted, #94a3b8)', margin: 0, lineHeight: '1.5' }}>
          Persistent memory engine with hybrid search, fact extraction, and confidence decay.
          {doctorSummary && ` ${doctorSummary}`}
        </p>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 32,
        }}>
          <StatCard label="Memories" value={stats.memories} />
          <StatCard label="Facts" value={stats.facts} sub={`${stats.sources} sources`} />
          <StatCard label="Storage" value={`${stats.storageMb} MB`} />
          <StatCard
            label="Embeddings"
            value={`${stats.embedCoverage}%`}
            sub={`${stats.embeddings.toLocaleString()} / ${stats.memories.toLocaleString()}`}
          />
        </div>
      )}

      {/* Confidence Distribution */}
      {stats?.confidenceDistribution && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Confidence Distribution
          </div>
          <div style={{ display: 'flex', gap: 2, height: 8, borderRadius: 4, overflow: 'hidden' }}>
            {(() => {
              const dist = stats.confidenceDistribution;
              const total = (dist.high || 0) + (dist.medium || 0) + (dist.low || 0);
              if (total === 0) return null;
              return (
                <>
                  <div style={{ flex: (dist.high || 0) / total, background: '#10b981', borderRadius: '4px 0 0 4px' }} title={`High: ${dist.high}`} />
                  <div style={{ flex: (dist.medium || 0) / total, background: '#f59e0b' }} title={`Medium: ${dist.medium}`} />
                  <div style={{ flex: (dist.low || 0) / total, background: '#ef4444', borderRadius: '0 4px 4px 0' }} title={`Low: ${dist.low}`} />
                </>
              );
            })()}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
            {[
              { label: 'High', color: '#10b981', count: stats.confidenceDistribution.high },
              { label: 'Medium', color: '#f59e0b', count: stats.confidenceDistribution.medium },
              { label: 'Low', color: '#ef4444', count: stats.confidenceDistribution.low },
            ].map(b => (
              <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.color }} />
                <span style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>
                  {b.label}: {(b.count || 0).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fact Types */}
      {stats?.factsByType && Object.keys(stats.factsByType).length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Fact Types
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(stats.factsByType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <span key={type} style={{
                  fontSize: 12,
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 8,
                  background: 'var(--t-bg-card, #f8fafc)',
                  border: '1px solid var(--t-border, #e2e8f0)',
                  color: 'var(--t-text, #0f172a)',
                }}>
                  {type} <span style={{ color: 'var(--t-text-muted, #94a3b8)', fontWeight: 600 }}>{count.toLocaleString()}</span>
                </span>
              ))}
          </div>
        </div>
      )}

      {/* LLM Provider + API Key */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
          LLM Provider
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 16px', lineHeight: '1.4' }}>
          Cortex uses an LLM for fact extraction, enrichment, and classification. Configure your provider and API key.
        </p>

        {/* Provider selector */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Provider
          </label>
          <select
            value={config?.llmProvider || ''}
            onChange={(e) => void saveConfig({ llmProvider: e.target.value })}
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              outline: 'none',
            }}
          >
            <option value="">— Select provider —</option>
            <option value="openrouter">OpenRouter (recommended — access all models)</option>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google AI</option>
            <option value="ollama">Ollama (local, no key needed)</option>
          </select>
        </div>

        {/* API Key */}
        {config?.llmProvider && config.llmProvider !== 'ollama' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
              API Key
              {config.llmApiKeySet && (
                <span style={{
                  marginLeft: 8,
                  fontSize: 10,
                  paddingTop: 2,
                  paddingBottom: 2,
                  paddingLeft: 6,
                  paddingRight: 6,
                  borderRadius: 4,
                  background: 'rgba(52,211,153,0.1)',
                  color: '#10b981',
                }}>
                  ✓ Configured
                </span>
              )}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKeyInput || (showApiKey ? '' : config.llmApiKey)}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={config.llmApiKeySet ? 'Enter new key to replace' : `Enter ${config.llmProvider} API key`}
                style={{
                  flex: 1,
                  paddingTop: 10,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 10,
                  border: '1px solid var(--t-border, #e2e8f0)',
                  background: 'var(--t-bg, white)',
                  color: 'var(--t-text, #0f172a)',
                  fontSize: 13,
                  fontFamily: 'ui-monospace, monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 10,
                  border: '1px solid var(--t-border, #e2e8f0)',
                  background: 'var(--t-bg, white)',
                  color: 'var(--t-text-muted, #94a3b8)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {showApiKey ? 'Hide' : 'Show'}
              </button>
              {apiKeyInput && (
                <button
                  type="button"
                  onClick={() => {
                    void saveConfig({ llmApiKey: apiKeyInput });
                    setApiKeyInput('');
                  }}
                  disabled={saving}
                  style={{
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 16,
                    paddingRight: 16,
                    borderRadius: 10,
                    border: 'none',
                    background: '#3b82f6',
                    color: 'white',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', marginTop: 6 }}>
              {config.llmProvider === 'openrouter' && (
                <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get an OpenRouter API key →
                </a>
              )}
              {config.llmProvider === 'anthropic' && (
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get an Anthropic API key →
                </a>
              )}
              {config.llmProvider === 'openai' && (
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get an OpenAI API key →
                </a>
              )}
              {config.llmProvider === 'google' && (
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                  Get a Google AI API key →
                </a>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Configuration Section */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 16 }}>
          Models
        </div>

        {/* Embedding Model */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Embedding Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 6px', lineHeight: '1.4' }}>
            Local Ollama model for semantic search embeddings. Requires Ollama running.
          </p>
          <select
            value={config?.embedModel || ''}
            onChange={(e) => void saveConfig({ embedModel: e.target.value })}
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
            }}
          >
            <option value="">— Not configured —</option>
            {/* Common embedding models */}
            <option value="ollama/nomic-embed-text">ollama/nomic-embed-text (recommended)</option>
            <option value="ollama/mxbai-embed-large">ollama/mxbai-embed-large</option>
            <option value="ollama/all-minilm">ollama/all-minilm</option>
            <option value="ollama/snowflake-arctic-embed">ollama/snowflake-arctic-embed</option>
            {/* Show any installed Ollama models that aren't already listed */}
            {ollamaModels
              .filter(m => !['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed'].some(k => m.includes(k)))
              .map(m => (
                <option key={m} value={`ollama/${m}`}>ollama/{m} (installed)</option>
              ))
            }
          </select>
        </div>

        {/* Enrichment Model — for fact extraction (Phase B) */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Enrichment Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 6px', lineHeight: '1.4' }}>
            LLM used for fact extraction and enrichment during imports. Runs through your configured LLM provider.
          </p>
          <input
            type="text"
            value={config?.enrichModel || ''}
            onChange={(e) => setConfig(prev => prev ? { ...prev, enrichModel: e.target.value } : prev)}
            onBlur={(e) => void saveConfig({ enrichModel: e.target.value })}
            placeholder="e.g. openrouter/x-ai/grok-4.1-fast"
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Classification Model */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 6 }}>
            Classification Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 6px', lineHeight: '1.4' }}>
            LLM used for reclassifying fact types. Cheaper model recommended.
          </p>
          <input
            type="text"
            value={config?.classifyModel || ''}
            onChange={(e) => setConfig(prev => prev ? { ...prev, classifyModel: e.target.value } : prev)}
            onBlur={(e) => void saveConfig({ classifyModel: e.target.value })}
            placeholder="e.g. openrouter/deepseek/deepseek-v3.2"
            disabled={saving}
            style={{
              width: '100%',
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {saveNote && (
          <div style={{
            fontSize: 12,
            color: saveNote === 'Saved' ? '#10b981' : '#ef4444',
            marginTop: 8,
          }}>
            {saveNote}
          </div>
        )}
      </div>

      {/* Paths */}
      {config && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Paths
          </div>
          <div style={{ fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', lineHeight: '1.8' }}>
            <div><span style={{ fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Config:</span> {config.configPath}</div>
            <div><span style={{ fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Database:</span> {config.dbPath}</div>
          </div>
        </div>
      )}

      {/* Growth (24h / 7d) */}
      {stats?.growth && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 12 }}>
            Growth
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <StatCard label="Memories (24h)" value={`+${stats.growth.memories_24h || 0}`} />
            <StatCard label="Memories (7d)" value={`+${stats.growth.memories_7d || 0}`} />
            <StatCard label="Facts (24h)" value={`+${stats.growth.facts_24h || 0}`} />
            <StatCard label="Facts (7d)" value={`+${stats.growth.facts_7d || 0}`} />
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
          Maintenance
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
          Run maintenance tasks to keep your memory healthy and search quality high.
        </p>
        <div style={{
          marginBottom: 12,
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid rgba(245, 158, 11, 0.2)',
          background: 'rgba(245, 158, 11, 0.08)',
          color: 'var(--t-text-secondary, #64748b)',
          fontSize: 11,
          lineHeight: 1.45,
        }}>
          <strong style={{ color: 'var(--t-text, #0f172a)' }}>Cleanup is destructive.</strong> It permanently removes garbage memories and headless facts, which can change recall and search results until they are rebuilt.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            { id: 'cleanup', label: 'Cleanup', desc: 'Remove garbage memories and headless facts', cmd: 'cleanup' },
            { id: 'lifecycle', label: 'Lifecycle', desc: 'Apply decay, promote, and conflict resolution policies', cmd: 'lifecycle run' },
            { id: 'conflicts', label: 'Find Conflicts', desc: 'Detect contradictory facts', cmd: 'conflicts --limit 10' },
            { id: 'optimize', label: 'Optimize DB', desc: 'VACUUM and ANALYZE the database', cmd: 'optimize' },
          ].map((action) => {
              const isCleanup = action.id === 'cleanup';
              return (
              <button
                key={action.id}
                type="button"
                title={isCleanup ? 'Permanently removes garbage memories and headless facts.' : action.desc}
                disabled={actionRunning !== null}
                onClick={async () => {
                  if (isCleanup) {
                    const confirmed = window.confirm(
                      'Cleanup permanently removes garbage memories and headless facts.\n\nThis is destructive and cannot be undone. It can change recall and search results until memory is rebuilt.\n\nContinue?',
                    );
                    if (!confirmed) return;
                  }
                  setActionRunning(action.id);
                  try {
                    const res = await fetch('/api/v2/cortex/action', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: action.cmd }),
                  });
                  if (res.ok) {
                    setSaveNote(`${action.label} complete`);
                    setTimeout(() => setSaveNote(''), 3000);
                    void loadConfig();
                  }
                } catch { /* ignore */ }
                setActionRunning(null);
              }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  paddingRight: 14,
                  borderRadius: 10,
                  border: isCleanup ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid var(--t-border, #e2e8f0)',
                  background: actionRunning === action.id
                    ? 'var(--t-bg-card, #f8fafc)'
                    : isCleanup
                      ? 'rgba(254, 242, 242, 0.92)'
                      : 'var(--t-bg, white)',
                  color: isCleanup ? '#b91c1c' : 'var(--t-text, #0f172a)',
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: actionRunning ? 'wait' : 'pointer',
                  transition: 'all 150ms',
                  opacity: actionRunning && actionRunning !== action.id ? 0.5 : 1,
                }}
              >
                {actionRunning === action.id ? '⏳' : '▸'} {action.label}
              </button>
              );
          })}
        </div>
        {saveNote && (
          <div style={{ fontSize: 12, color: '#10b981', marginTop: 8, fontWeight: 500 }}>
            ✓ {saveNote}
          </div>
        )}
      </div>

      {/* Conflicts */}
      <div style={{ marginBottom: 32, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)' }}>
              Conflicts
            </div>
            {conflictsChecked && (
              <span style={{
                fontSize: 11,
                fontWeight: 700,
                paddingTop: 2,
                paddingBottom: 2,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 999,
                background: conflicts.length > 0 ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
                color: conflicts.length > 0 ? '#dc2626' : '#16a34a',
              }}>
                {conflicts.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void checkConflicts()}
            disabled={conflictsLoading || resolving !== null}
            style={{
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 10,
              border: '1px solid var(--t-border, #e2e8f0)',
              background: 'var(--t-bg, white)',
              color: 'var(--t-text, #0f172a)',
              fontSize: 12,
              fontWeight: 600,
              cursor: conflictsLoading || resolving !== null ? 'wait' : 'pointer',
              opacity: conflictsLoading || resolving !== null ? 0.7 : 1,
            }}
          >
            {conflictsLoading ? 'Checking…' : 'Check Conflicts'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
          Review contradictory facts and decide which version Cortex should keep.
        </p>

        {conflictError && (
          <div style={{
            fontSize: 12,
            color: '#dc2626',
            marginBottom: 12,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 10,
            border: '1px solid rgba(239,68,68,0.12)',
            background: 'rgba(239,68,68,0.04)',
          }}>
            {conflictError}
          </div>
        )}

        {!conflictsChecked && !conflictsLoading && (
          <div style={{
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 12,
            border: '1px dashed var(--t-border, #e2e8f0)',
            background: 'rgba(148,163,184,0.03)',
            color: 'var(--t-text-muted, #94a3b8)',
            fontSize: 12,
          }}>
            Run a fresh scan to inspect up to 20 contradictory fact pairs.
          </div>
        )}

        {conflictsLoading && (
          <div style={{
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 12,
            border: '1px solid var(--t-border, #e2e8f0)',
            background: 'var(--t-bg-card, #f8fafc)',
            color: 'var(--t-text-muted, #94a3b8)',
            fontSize: 12,
          }}>
            Scanning Cortex for contradictory facts…
          </div>
        )}

        {conflictsChecked && !conflictsLoading && conflicts.length === 0 && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--t-text-muted)' }}>
            <span style={{ fontSize: 13 }}>No conflicts found — your knowledge base is consistent ✓</span>
          </div>
        )}

        {conflictsChecked && !conflictsLoading && conflicts.length > 0 && (
          <div>
            {conflicts.map((pair) => {
              const pairKey = `${pair.factA.id}-${pair.factB.id}`;
              const pairResolving = resolving === pair.factA.id || resolving === pair.factB.id;
              const subject = pair.factA.subject || pair.factB.subject;
              const predicate = pair.factA.predicate || pair.factB.predicate;

              return (
                <div
                  key={pairKey}
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    border: '1px solid var(--t-border, #e2e8f0)',
                    background: 'var(--t-bg-card, #f8fafc)',
                    marginBottom: 12,
                    opacity: pairResolving ? 0 : 1,
                    transform: pairResolving ? 'translateY(-8px) scale(0.98)' : 'translateY(0) scale(1)',
                    transition: 'opacity 180ms ease, transform 180ms ease',
                    pointerEvents: pairResolving ? 'none' : 'auto',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', marginBottom: 12 }}>
                    <span style={{ color: '#2563eb' }}>{subject}</span>
                    <span style={{ color: 'var(--t-text-muted)', margin: '0 6px' }}>→</span>
                    <span>{predicate}</span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {[
                      { fact: pair.factA, other: pair.factB, side: 'A' },
                      { fact: pair.factB, other: pair.factA, side: 'B' },
                    ].map(({ fact, other, side }) => {
                      const keepBusy = resolving === fact.id;
                      const otherBusy = resolving === other.id;

                      return (
                        <div
                          key={`${pairKey}-${side}`}
                          style={{
                            padding: 12,
                            borderRadius: 10,
                            border: '1px solid var(--t-border, #e2e8f0)',
                            background: 'var(--t-bg, white)',
                          }}
                        >
                          <div style={{
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                            color: 'var(--t-text-muted, #94a3b8)',
                            marginBottom: 8,
                          }}>
                            Fact {side}
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)', marginBottom: 8, lineHeight: '1.45' }}>
                            &quot;{fact.object}&quot;
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--t-text-muted, #94a3b8)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                            <span>Confidence: {(fact.confidence * 100).toFixed(0)}%</span>
                            <span>·</span>
                            <span>Source: {fact.source}</span>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--t-text-muted, #94a3b8)', display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                            <span>Last seen: {formatConflictDate(fact.lastSeen)}</span>
                            <span>·</span>
                            <span>ID: {fact.id}</span>
                            {fact.factType ? (
                              <>
                                <span>·</span>
                                <span>Type: {fact.factType}</span>
                              </>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              onClick={() => void resolveConflict(fact.id, other.id)}
                              disabled={resolving !== null}
                              style={{
                                flex: 1,
                                padding: '6px 0',
                                borderRadius: 8,
                                border: '1px solid rgba(34,197,94,0.3)',
                                background: 'rgba(34,197,94,0.06)',
                                color: '#16a34a',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: resolving !== null ? 'wait' : 'pointer',
                                opacity: resolving !== null ? 0.7 : 1,
                              }}
                            >
                              {keepBusy ? 'Resolving…' : 'Keep this'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void resolveConflict(other.id, fact.id)}
                              disabled={resolving !== null}
                              style={{
                                padding: '6px 10px',
                                borderRadius: 8,
                                border: '1px solid rgba(239,68,68,0.2)',
                                background: 'transparent',
                                color: '#dc2626',
                                fontSize: 11,
                                fontWeight: 500,
                                cursor: resolving !== null ? 'wait' : 'pointer',
                                opacity: resolving !== null ? 0.7 : 1,
                              }}
                            >
                              {otherBusy ? 'Keeping other…' : 'Drop'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {conflictToast && (
          <div style={{
            position: 'fixed',
            right: 24,
            bottom: 24,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 12,
            border: '1px solid rgba(34,197,94,0.18)',
            background: 'rgba(15,23,42,0.94)',
            color: '#dcfce7',
            fontSize: 12,
            fontWeight: 600,
            boxShadow: '0 18px 40px rgba(15,23,42,0.18)',
            zIndex: 40,
          }}>
            {conflictToast}
          </div>
        )}
      </div>

      {/* Chat Memory Settings */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 4 }}>
          Chat Memory
        </div>
        <p style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)', margin: '0 0 12px', lineHeight: '1.4' }}>
          When enabled, the LLM chat searches Cortex for relevant memories before each message and injects them as context.
          The model remembers decisions, preferences, and project details across conversations.
        </p>
        <div style={{
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16,
          borderRadius: 12,
          border: '1px solid var(--t-border, #e2e8f0)',
          background: 'var(--t-bg-card, #f8fafc)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Memory Recall</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Search Cortex before each LLM request</div>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setConfig(prev => prev ? { ...prev, recallEnabled: !recallEnabled } : prev);
                  void saveConfig({ recallEnabled: !recallEnabled });
                }}
                aria-pressed={recallEnabled}
                style={{
                  width: 36,
                  height: 20,
                  borderRadius: 10,
                  border: 'none',
                  background: recallEnabled ? '#3b82f6' : '#cbd5e1',
                  position: 'relative',
                  cursor: saving ? 'default' : 'pointer',
                  transition: 'background 150ms',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                <div style={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: 'white',
                  position: 'absolute',
                  top: 2,
                  left: recallEnabled ? 18 : 2,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  transition: 'left 150ms',
                }} />
              </button>
            </div>
            <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Max Results</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Top N facts injected per request</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{recallMaxResults}</span>
            </div>
            <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Token Budget</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Max tokens used for memory context</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{recallTokenBudget}</span>
            </div>
            <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Min Confidence</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Facts below this score are excluded</div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{recallMinConfidence}</span>
            </div>
            {config?.sourceBoostCount != null && config.sourceBoostCount > 0 && (
              <>
                <div style={{ height: 1, background: 'var(--t-border, #e2e8f0)' }} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text, #0f172a)' }}>Source Boost Rules</div>
                    <div style={{ fontSize: 11, color: 'var(--t-text-muted, #94a3b8)' }}>Custom source weighting configured</div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', fontFamily: 'ui-monospace, monospace' }}>{config.sourceBoostCount}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Getting Started / Setup Guide */}
      {(!stats || !config?.llmApiKeySet) && (
        <div style={{
          marginBottom: 32,
          paddingTop: 20,
          paddingBottom: 20,
          paddingLeft: 20,
          paddingRight: 20,
          borderRadius: 12,
          border: '1px dashed var(--t-border, #e2e8f0)',
          background: 'rgba(59,130,246,0.02)',
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text, #0f172a)', marginBottom: 8 }}>
            Getting Started
          </div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--t-text-muted, #94a3b8)', lineHeight: '1.8' }}>
            <li style={{ color: config?.llmApiKeySet ? '#10b981' : undefined }}>
              {config?.llmApiKeySet ? '✓' : '→'} Configure an LLM provider and API key above
            </li>
            <li style={{ color: config?.embedModel ? '#10b981' : undefined }}>
              {config?.embedModel ? '✓' : '→'} Install Ollama and pull an embedding model: <code style={{ fontSize: 11, background: 'var(--t-bg-card, #f1f5f9)', paddingTop: 1, paddingBottom: 1, paddingLeft: 4, paddingRight: 4, borderRadius: 3 }}>ollama pull nomic-embed-text</code>
            </li>
            <li>
              → Import your first memories: <code style={{ fontSize: 11, background: 'var(--t-bg-card, #f1f5f9)', paddingTop: 1, paddingBottom: 1, paddingLeft: 4, paddingRight: 4, borderRadius: 3 }}>cortex import ~/notes --extract</code>
            </li>
            <li>
              → Chat with memory — Cortex automatically recalls relevant facts
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
