'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, ChevronDown, FileCode, FilePlus, PenLine, Eye } from 'lucide-react';

/* ── Types ── */
interface DiffEntry {
  id: string;
  file: string;
  shortFile: string;
  tool: 'Edit' | 'Write' | 'Read' | 'MultiEdit';
  oldText?: string;
  newText?: string;
  content?: string;
  timestamp: number;
}

interface LiveOutputProps {
  agentName: string;
  agentRuntime: string;
  sessionKey: string;
  onClose: () => void;
}

/* ── Diff line computation ── */
function computeDiffLines(oldText: string, newText: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: { type: 'same' | 'add' | 'del'; text: string }[] = [];

  // Simple diff: show removed lines first, then added lines
  // For matching lines, show as 'same'
  const maxLen = Math.max(oldLines.length, newLines.length);

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < Math.min(oldLines.length, newLines.length) && oldLines[prefixLen] === newLines[prefixLen]) {
    result.push({ type: 'same', text: oldLines[prefixLen] });
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < Math.min(oldLines.length - prefixLen, newLines.length - prefixLen) &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Middle section: deletions then additions
  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);

  for (const line of oldMiddle) result.push({ type: 'del', text: line });
  for (const line of newMiddle) result.push({ type: 'add', text: line });

  // Common suffix
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    result.push({ type: 'same', text: oldLines[i] });
  }

  return result;
}

/* ── Single Diff Card ── */
function DiffCard({ diff, isLatest }: { diff: DiffEntry; isLatest: boolean }) {
  const [expanded, setExpanded] = useState(isLatest);
  const isEdit = diff.tool === 'Edit' || diff.tool === 'MultiEdit';
  const isWrite = diff.tool === 'Write';
  const hasContent = isEdit ? (diff.oldText && diff.newText) : isWrite ? diff.content : false;

  const lines = isEdit && diff.oldText && diff.newText
    ? computeDiffLines(diff.oldText, diff.newText)
    : [];

  const additions = lines.filter(l => l.type === 'add').length;
  const deletions = lines.filter(l => l.type === 'del').length;

  const age = Math.round((Date.now() - diff.timestamp) / 1000);
  const ageLabel = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;

  return (
    <div style={{
      borderRadius: 10,
      overflow: 'hidden',
      border: isLatest
        ? '1px solid rgba(147, 197, 253, 0.15)'
        : '1px solid rgba(147, 197, 253, 0.06)',
      background: isLatest
        ? 'rgba(147, 197, 253, 0.04)'
        : 'rgba(255, 255, 255, 0.015)',
      animation: isLatest ? 'diffCardSlideIn 400ms cubic-bezier(0.32, 0.72, 0, 1)' : 'none',
      transition: 'border-color 200ms ease',
    }}>
      {/* File header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          paddingTop: 8,
          paddingRight: 12,
          paddingBottom: 8,
          paddingLeft: 12,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {isEdit ? <PenLine size={13} color="rgba(147, 197, 253, 0.7)" /> :
         isWrite ? <FilePlus size={13} color="rgba(52, 211, 153, 0.7)" /> :
         <Eye size={13} color="rgba(148, 163, 184, 0.5)" />}

        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'rgba(226, 232, 240, 0.9)',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {diff.shortFile}
        </span>

        {/* Stats pills */}
        {isEdit && (additions > 0 || deletions > 0) && (
          <span style={{
            display: 'flex',
            gap: 4,
            fontSize: 10,
            fontWeight: 600,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          }}>
            {additions > 0 && <span style={{ color: '#34d399' }}>+{additions}</span>}
            {deletions > 0 && <span style={{ color: '#93c5fd' }}>−{deletions}</span>}
          </span>
        )}
        {isWrite && <span style={{ fontSize: 10, color: 'rgba(52, 211, 153, 0.6)', fontWeight: 500 }}>new</span>}

        <span style={{
          fontSize: 9,
          color: 'rgba(148, 163, 184, 0.35)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {ageLabel}
        </span>

        <ChevronDown
          size={12}
          color="rgba(148, 163, 184, 0.3)"
          style={{
            transition: 'transform 200ms ease',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            flexShrink: 0,
          }}
        />
      </button>

      {/* Expanded diff content */}
      {expanded && hasContent && (
        <div style={{
          borderTop: '1px solid rgba(147, 197, 253, 0.06)',
          maxHeight: 260,
          overflow: 'auto',
        }}>
          {isEdit && lines.length > 0 && (
            <div style={{
              fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.7,
            }}>
              {lines.filter(l => l.type !== 'same').map((line, i) => (
                <div
                  key={i}
                  style={{
                    paddingTop: 0,
                    paddingRight: 12,
                    paddingBottom: 0,
                    paddingLeft: 12,
                    background: line.type === 'add'
                      ? 'rgba(52, 211, 153, 0.06)'
                      : line.type === 'del'
                        ? 'rgba(147, 197, 253, 0.04)'
                        : 'transparent',
                    color: line.type === 'add'
                      ? 'rgba(52, 211, 153, 0.85)'
                      : line.type === 'del'
                        ? 'rgba(147, 197, 253, 0.5)'
                        : 'rgba(226, 232, 240, 0.4)',
                    borderLeft: line.type === 'add'
                      ? '2px solid rgba(52, 211, 153, 0.4)'
                      : line.type === 'del'
                        ? '2px solid rgba(147, 197, 253, 0.2)'
                        : '2px solid transparent',
                    whiteSpace: 'pre',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <span style={{
                    display: 'inline-block',
                    width: 16,
                    textAlign: 'center',
                    color: line.type === 'add'
                      ? 'rgba(52, 211, 153, 0.5)'
                      : 'rgba(147, 197, 253, 0.35)',
                    userSelect: 'none',
                    marginRight: 4,
                  }}>
                    {line.type === 'add' ? '+' : '−'}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          )}

          {isWrite && diff.content && (
            <div style={{
              fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
              fontSize: 11,
              lineHeight: 1.7,
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 6,
              paddingLeft: 12,
              color: 'rgba(52, 211, 153, 0.7)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflow: 'auto',
            }}>
              {diff.content.slice(0, 600)}{diff.content.length > 600 ? '\n…' : ''}
            </div>
          )}
        </div>
      )}

      {/* File path subtitle */}
      {expanded && (
        <div style={{
          paddingTop: 4,
          paddingRight: 12,
          paddingBottom: 6,
          paddingLeft: 34,
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.25)',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {diff.file}
        </div>
      )}
    </div>
  );
}

/* ── File summary bar ── */
function FileSummaryBar({ diffs }: { diffs: DiffEntry[] }) {
  const files = new Map<string, { adds: number; dels: number; tool: string }>();
  for (const d of diffs) {
    const existing = files.get(d.shortFile) ?? { adds: 0, dels: 0, tool: d.tool };
    if (d.oldText && d.newText) {
      const lines = computeDiffLines(d.oldText, d.newText);
      existing.adds += lines.filter(l => l.type === 'add').length;
      existing.dels += lines.filter(l => l.type === 'del').length;
    }
    if (d.tool === 'Write') existing.tool = 'Write';
    files.set(d.shortFile, existing);
  }

  return (
    <div style={{
      display: 'flex',
      gap: 6,
      paddingTop: 4,
      paddingRight: 12,
      paddingBottom: 4,
      paddingLeft: 12,
      overflowX: 'auto',
      flexShrink: 0,
    }}>
      {[...files.entries()].map(([name, stats]) => (
        <span
          key={name}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 2,
            paddingRight: 8,
            paddingBottom: 2,
            paddingLeft: 6,
            borderRadius: 6,
            background: 'rgba(147, 197, 253, 0.06)',
            border: '1px solid rgba(147, 197, 253, 0.08)',
            fontSize: 10,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
            color: 'rgba(226, 232, 240, 0.6)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <FileCode size={10} color="rgba(147, 197, 253, 0.5)" />
          {name}
          {stats.adds > 0 && <span style={{ color: '#34d399', fontWeight: 600 }}>+{stats.adds}</span>}
          {stats.dels > 0 && <span style={{ color: '#93c5fd', fontWeight: 600 }}>−{stats.dels}</span>}
          {stats.tool === 'Write' && <span style={{ color: 'rgba(52, 211, 153, 0.5)' }}>new</span>}
        </span>
      ))}
    </div>
  );
}

/* ── Main Component ── */
export function LiveOutput({ agentName, agentRuntime, sessionKey, onClose }: LiveOutputProps) {
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const prevCountRef = useRef(0);

  const fetchDiffs = useCallback(async () => {
    try {
      // Use diffs API for Claude Code, fall back to transcript for others
      const isClaudeCode = sessionKey.startsWith('claude-code:');

      if (isClaudeCode) {
        const res = await fetch(`/api/claude-code/diffs?limit=30`);
        if (!res.ok) return;
        const data = await res.json();
        const newDiffs = (data.diffs ?? []) as DiffEntry[];
        if (newDiffs.length !== prevCountRef.current) {
          setDiffs(newDiffs);
          prevCountRef.current = newDiffs.length;
        }
      } else {
        // For Codex/OpenClaw — use transcript and extract file references
        const url = sessionKey.startsWith('codex:')
          ? `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`
          : `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        const transcript = data.transcript ?? data.entries ?? [];

        // Extract file mentions from assistant messages
        const extracted: DiffEntry[] = [];
        for (const entry of transcript) {
          if (entry.role !== 'assistant') continue;
          const text = entry.text ?? '';
          const fileMatches = text.matchAll(/(?:edit|wrote?|created?|modified?|updated?)\s+[`"*]?([^\s`"*]+\.\w{1,6})[`"*]?/gi);
          for (const match of fileMatches) {
            extracted.push({
              id: `${entry.id}-${match[1]}`,
              file: match[1],
              shortFile: match[1].split('/').pop() ?? match[1],
              tool: 'Edit',
              timestamp: Date.now(),
            });
          }
        }
        if (extracted.length !== prevCountRef.current) {
          setDiffs(extracted);
          prevCountRef.current = extracted.length;
        }
      }
    } catch { /* silent */ }
  }, [sessionKey]);

  useEffect(() => {
    void fetchDiffs();
    pollRef.current = setInterval(fetchDiffs, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchDiffs]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [diffs]);

  const runtimeLabel = agentRuntime === 'claude-code' ? 'Claude Code'
    : agentRuntime === 'codex' ? 'Codex'
    : 'OpenClaw';

  const totalAdds = diffs.reduce((sum, d) => {
    if (!d.oldText || !d.newText) return sum;
    return sum + computeDiffLines(d.oldText, d.newText).filter(l => l.type === 'add').length;
  }, 0);
  const totalDels = diffs.reduce((sum, d) => {
    if (!d.oldText || !d.newText) return sum;
    return sum + computeDiffLines(d.oldText, d.newText).filter(l => l.type === 'del').length;
  }, 0);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      height: '100%',
      background: 'rgba(10, 12, 18, 0.75)',
      backdropFilter: 'blur(32px)',
      WebkitBackdropFilter: 'blur(32px)',
      borderBottom: '1px solid rgba(147, 197, 253, 0.06)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 14,
        flexShrink: 0,
        borderBottom: '1px solid rgba(147, 197, 253, 0.05)',
      }}>
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: diffs.length > 0 ? '#34c759' : 'rgba(148, 163, 184, 0.3)',
          boxShadow: diffs.length > 0 ? '0 0 8px rgba(52, 199, 89, 0.4)' : 'none',
          animation: diffs.length > 0 ? 'livePulse 2.5s ease-in-out infinite' : 'none',
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'rgba(226, 232, 240, 0.85)',
          letterSpacing: '-0.01em',
        }}>
          {agentName}
        </span>
        <span style={{
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.4)',
        }}>
          {runtimeLabel}
        </span>

        {/* Total stats */}
        {(totalAdds > 0 || totalDels > 0) && (
          <span style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
            fontWeight: 600,
            display: 'flex',
            gap: 4,
          }}>
            {totalAdds > 0 && <span style={{ color: 'rgba(52, 211, 153, 0.7)' }}>+{totalAdds}</span>}
            {totalDels > 0 && <span style={{ color: 'rgba(147, 197, 253, 0.5)' }}>−{totalDels}</span>}
          </span>
        )}

        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: 'rgba(148, 163, 184, 0.4)' }}
        >
          <ChevronDown size={13} style={{ transition: 'transform 200ms', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }} />
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', color: 'rgba(148, 163, 184, 0.3)' }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'rgba(239, 68, 68, 0.7)'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'rgba(148, 163, 184, 0.3)'; }}
        >
          <X size={13} />
        </button>
      </div>

      {/* File summary bar */}
      {!collapsed && diffs.length > 0 && <FileSummaryBar diffs={diffs} />}

      {/* Diff cards */}
      {!collapsed && (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: 'auto',
            paddingTop: 6,
            paddingRight: 10,
            paddingBottom: 10,
            paddingLeft: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {diffs.length === 0 ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              gap: 8,
            }}>
              <FileCode size={24} color="rgba(148, 163, 184, 0.12)" />
              <span style={{ fontSize: 12, color: 'rgba(148, 163, 184, 0.25)', fontStyle: 'italic' }}>
                Watching for changes…
              </span>
            </div>
          ) : (
            diffs.map((diff, i) => (
              <DiffCard key={diff.id} diff={diff} isLatest={i === diffs.length - 1} />
            ))
          )}
        </div>
      )}

      <style>{`
        @keyframes livePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes diffCardSlideIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
