import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, Brain, Check, ChevronRight, Copy, FileText, GitBranch, Loader2, Pencil, RefreshCw, Square, ThumbsDown, ThumbsUp, Trash2, Volume2, VolumeOff } from '../lucide-shims';

import { DesktopToolCallStack } from '../DesktopToolCallStack';
import { renderLLMMarkdown } from '../LLMMarkdown';
import { ChainOfThought } from './ChainOfThought';
import { deriveFileChangesFromTools, THEME_ACCENT, THEME_ACCENT_BORDER, THEME_ACCENT_SOFT, THEME_ACCENT_SOFT_STRONG, THEME_BG_CARD, THEME_PANEL_GLASS, type FileChangePreview, type LLMMessage, type ToolCallInfo } from './shared';

const ACTION_BTN_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: '1px solid var(--t-panel-border)',
  background: THEME_BG_CARD,
  color: 'var(--t-text-secondary)',
  cursor: 'pointer',
  borderRadius: 8,
  transition: 'color 150ms, background 150ms, border-color 150ms',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

const STACK_HIDDEN_TOOL_NAMES = new Set([
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'notebookedit',
  'notebook_edit',
  'edit_file',
  'write_file',
  'apply_patch',
]);

const NARRATIVE_COMMAND_HINT = /\/| -[A-Za-z]|[`'"]|^(?:bash|zsh|sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|git|npm|npx|pnpm|yarn|node|python(?:3)?|uv|pytest|rg|grep|sed|cat|ls|find|make|cargo|go|docker|kubectl)\b/i;

function normalizeExecToolCall(tool: ToolCallInfo): ToolCallInfo {
  const name = tool.name.toLowerCase();
  if (name !== 'exec' && name !== 'exec_command') return tool;
  if (!tool.args || typeof tool.args !== 'object') return tool;

  const existingCommand = typeof tool.args.command === 'string'
    ? tool.args.command.trim()
    : typeof tool.args.cmd === 'string'
      ? tool.args.cmd.trim()
      : '';
  if (existingCommand) return tool;

  const rawInput = typeof tool.args.input === 'string' ? tool.args.input.trim() : '';
  if (!rawInput) return tool;

  const command = rawInput.replace(/^Run\s+/i, '').trim();
  if (!command || command === rawInput) return tool;

  return {
    ...tool,
    args: {
      ...tool.args,
      command,
    },
  };
}

function toolCallFromNarrative(content: string): ToolCallInfo | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  const match = trimmed.match(/^Run\s+(.+)$/i);
  const command = match?.[1]?.trim();
  if (!command || !NARRATIVE_COMMAND_HINT.test(command)) return null;

  return {
    name: 'exec_command',
    status: 'done',
    args: { command },
  };
}

function ActionButton({ active, activeColor, icon, label, onClick }: { active?: boolean; activeColor?: string; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{ ...ACTION_BTN_STYLE, color: active ? (activeColor || '#10b981') : '#cbd5e1' }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text-secondary)';
        event.currentTarget.style.background = THEME_ACCENT_SOFT;
        event.currentTarget.style.borderColor = THEME_ACCENT_BORDER;
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text-faint)';
        event.currentTarget.style.background = THEME_BG_CARD;
        event.currentTarget.style.borderColor = 'var(--t-panel-border)';
      }}
    >
      {icon}
    </button>
  );
}

function FileChangeCard({ change }: { change: FileChangePreview }) {
  const [expanded, setExpanded] = useState(false);
  const isWrite = Boolean(change.content && !change.oldText && !change.newText);

  return (
    <div style={{ width: '100%' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, background: THEME_BG_CARD, border: '1px solid var(--t-panel-border)', borderRadius: 12, cursor: 'pointer', textAlign: 'left' }}
      >
        <ChevronRight size={14} style={{ color: 'var(--t-text-secondary)', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 160ms ease', flexShrink: 0 }} />
        <FileText size={14} style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>1 file changed</div>
          <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{change.shortFile}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}>+{change.additions}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626' }}>-{change.deletions}</span>
        </div>
      </button>
      {expanded ? (
        <div style={{ marginTop: 8, border: '1px solid var(--t-panel-border)', borderRadius: 12, overflow: 'hidden', background: THEME_PANEL_GLASS }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, borderBottom: '1px solid var(--t-divider)', background: THEME_BG_CARD }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{change.path}</div>
            <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', fontWeight: 700 }}>{change.tool}</div>
          </div>
          <div style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
            {isWrite ? (
              <pre style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text)' }}>{change.content}</pre>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>Before</div>
                  <pre style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, borderRadius: 10, background: 'rgba(127, 29, 29, 0.18)', color: '#7f1d1d', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, fontFamily: '"SF Mono", ui-monospace, monospace', minHeight: 80 }}>{change.oldText || 'No previous content'}</pre>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', marginBottom: 6 }}>After</div>
                  <pre style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, borderRadius: 10, background: 'rgba(20, 83, 45, 0.22)', color: '#14532d', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, fontFamily: '"SF Mono", ui-monospace, monospace', minHeight: 80 }}>{change.newText || 'No updated content'}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MessageBubbleBase({
  message,
  isLast,
  onRetry,
  onEdit,
  onDelete,
  onFork,
  onApplyToFile,
  onApplyDiff,
  onOpenInCanvas,
  onRunInTerminal,
}: {
  message: LLMMessage;
  isLast: boolean;
  onRetry?: () => void;
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  onFork?: () => void;
  onApplyToFile?: (code: string, language: string) => void;
  onApplyDiff?: (diffText: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<'up' | 'down' | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [ttsState, setTtsState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isUser = message.role === 'user';
  const syntheticNarrativeToolCall = !isUser && !(message.toolCalls?.length) ? toolCallFromNarrative(message.content) : null;
  const visibleContent = !isUser && syntheticNarrativeToolCall ? '' : message.content;
  const hasVisibleContent = visibleContent.trim().length > 0;
  const fileChanges = !isUser ? deriveFileChangesFromTools(message.toolCalls) : [];
  const visibleToolCalls = !isUser
    ? [...(message.toolCalls ?? []).map(normalizeExecToolCall), ...(syntheticNarrativeToolCall ? [syntheticNarrativeToolCall] : [])]
      .filter((tool) => !STACK_HIDDEN_TOOL_NAMES.has(tool.name.toLowerCase()))
    : [];

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  const handleSpeak = useCallback(async () => {
    if (ttsState === 'playing') {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setTtsState('idle');
      setTtsProgress(0);
      return;
    }
    if (ttsState === 'loading') return;
    setTtsState('loading');
    try {
      const cleanText = visibleContent.replace(/```[\s\S]*?```/g, ' code block ').replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]+\)/g, ' image ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#*_~|>/]/g, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').trim();
      const response = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: cleanText }) });
      if (!response.ok) throw new Error('TTS failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener('timeupdate', () => {
        if (audio.duration > 0) {
          setTtsProgress((audio.currentTime / audio.duration) * 100);
        }
      });
      audio.addEventListener('ended', () => {
        setTtsState('idle');
        setTtsProgress(0);
        URL.revokeObjectURL(url);
        audioRef.current = null;
      });
      audio.addEventListener('error', () => {
        setTtsState('idle');
        setTtsProgress(0);
        audioRef.current = null;
      });
      await audio.play();
      setTtsState('playing');
    } catch {
      setTtsState('idle');
      setTtsProgress(0);
    }
  }, [ttsState, visibleContent]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(visibleContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [visibleContent]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 4, animation: isLast ? 'llmFadeIn 200ms ease-out' : undefined }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {isUser || hasVisibleContent ? (
        <div style={{ maxWidth: isUser ? '85%' : '90%', paddingTop: isUser ? 8 : 16, paddingRight: isUser ? 14 : 0, paddingBottom: isUser ? 8 : 16, paddingLeft: isUser ? 14 : 0, borderRadius: isUser ? '14px 14px 4px 14px' : 0, background: isUser ? 'rgba(99, 138, 255, 0.13)' : message.isError ? 'rgba(239,68,68,0.12)' : 'transparent', color: isUser ? 'var(--t-text)' : message.isError ? '#dc2626' : 'var(--t-text)', fontSize: 13, fontWeight: isUser ? 380 : 360, lineHeight: '1.55', letterSpacing: '-0.005em', fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif', wordBreak: 'break-word', ...(isUser ? { whiteSpace: 'pre-wrap' as const } : {}) }}>
          {isUser ? (
            <>
              {visibleContent}
              {message.images && message.images.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {message.images.map((image, index) => (
                    <img key={`${image}-${index}`} src={image} alt={`Attached ${index + 1}`} style={{ maxWidth: 200, maxHeight: 200, borderRadius: 10, objectFit: 'cover', border: '1px solid var(--t-border)' }} />
                  ))}
                </div>
              ) : null}
            </>
          ) : renderLLMMarkdown(visibleContent, { onApplyToFile, onApplyDiff, onOpenInCanvas, onRunInTerminal })}
        </div>
      ) : null}

      {!isUser && message.fallbackNotice ? (
        <div style={{ maxWidth: '90%', paddingTop: 2, paddingBottom: 6, paddingLeft: 2, fontSize: 11, color: 'var(--t-text-muted)', fontStyle: 'italic', fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif', display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="12" height="12" viewBox="0 0 256 256" fill="none" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M236.8 188.09 149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19 23.51 23.51 0 0 0 .02-23.72ZM120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z" fill="currentColor" />
          </svg>
          {message.fallbackNotice}
        </div>
      ) : null}

      {!isUser && message.isPartial ? <div style={{ maxWidth: '90%', paddingLeft: 2, fontSize: 11, color: 'var(--t-text-muted)', fontStyle: 'italic' }}>Recovered after reload</div> : null}
      {!isUser && (message.thinkingSteps || message.thinking) ? <ChainOfThought steps={message.thinkingSteps || []} thinking={message.thinking} durationMs={message.thinkingDurationMs} /> : null}
      {!isUser && fileChanges.length > 0 ? <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: '90%', marginTop: 4 }}>{fileChanges.map((change) => <FileChangeCard key={change.id} change={change} />)}</div> : null}
      {!isUser && visibleToolCalls.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '90%', marginTop: 4 }}>
          <DesktopToolCallStack toolCalls={visibleToolCalls} />
        </div>
      ) : null}
      {!isUser && message.sources && message.sources.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: '90%', marginTop: 6 }}>
          {message.sources.map((source, index) => (
            <a
              key={`${source.title}-${index}`}
              href={source.url || '#'}
              target={source.url ? '_blank' : undefined}
              rel="noopener noreferrer"
              onClick={source.path && !source.url ? (event) => event.preventDefault() : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 8, background: THEME_ACCENT_SOFT, border: `1px solid ${THEME_ACCENT_BORDER}`, borderRadius: 6, fontSize: 11, color: THEME_ACCENT, textDecoration: 'none', fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif', transition: 'background 100ms', cursor: 'pointer', animation: 'llmFadeIn 200ms ease-out' }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = THEME_ACCENT_SOFT_STRONG;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = THEME_ACCENT_SOFT;
              }}
            >
              {source.index ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', background: THEME_ACCENT, color: '#ffffff', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>{source.index}</span> : null}
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.title}</span>
            </a>
          ))}
        </div>
      ) : null}

      {!isUser && ttsState !== 'idle' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 2, paddingLeft: 2, maxWidth: '90%', animation: 'llmFadeIn 200ms ease-out' }}>
          <button type="button" onClick={handleSpeak} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: '50%', border: 'none', background: ttsState === 'playing' ? '#3b82f6' : '#e2e8f0', color: ttsState === 'playing' ? '#ffffff' : '#94a3b8', cursor: 'pointer', transition: 'all 200ms', flexShrink: 0 }}>
            {ttsState === 'loading' ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Square size={12} fill="currentColor" />}
          </button>
          <div style={{ flex: 1, height: 4, background: '#e2e8f0', borderRadius: 2, overflow: 'hidden', minWidth: 100 }}>
            {ttsState === 'loading' ? <div style={{ width: '30%', height: '100%', background: 'linear-gradient(90deg, #3b82f6, #60a5fa, #3b82f6)', borderRadius: 2, animation: 'ttsShimmer 1.5s ease-in-out infinite' }} /> : <div style={{ width: `${ttsProgress}%`, height: '100%', background: '#3b82f6', borderRadius: 2, transition: 'width 100ms linear' }} />}
          </div>
          {ttsState === 'playing' ? <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>{[0, 1, 2, 3, 4].map((index) => <div key={index} style={{ width: 3, background: '#3b82f6', borderRadius: 1.5, animation: `ttsWave 0.8s ease-in-out ${index * 0.1}s infinite alternate` }} />)}</div> : null}
        </div>
      ) : null}

      {!isUser && hasVisibleContent ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingTop: 2, paddingBottom: 4, opacity: hovered || isLast ? 1 : 0, transition: 'opacity 150ms' }}>
          {message.model ? <span style={{ fontSize: 11, color: 'var(--t-text-muted)', marginRight: 4, fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif' }}>{message.model}</span> : null}
          {message.tokens ? <span style={{ fontSize: 10, color: 'var(--t-text-faint)', marginRight: 4, fontFamily: 'ui-monospace, monospace' }}>{message.tokens.input + message.tokens.output} tok</span> : null}
          {message.costUsd != null && message.costUsd > 0 ? <span style={{ fontSize: 10, color: 'var(--t-text-faint)', marginRight: 6, fontFamily: 'ui-monospace, monospace' }}>${message.costUsd.toFixed(4)}</span> : null}
          {message.recalledFacts != null && message.recalledFacts > 0 ? <span title={`${message.recalledFacts} memor${message.recalledFacts === 1 ? 'y' : 'ies'} recalled from Cortex`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#8b5cf6', marginRight: 4, fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif' }}><Brain size={10} />{message.recalledFacts}</span> : null}
          <div style={{ width: 1, height: 14, background: 'var(--t-divider)', marginLeft: 2, marginRight: 2 }} />
          <ActionButton icon={copied ? <Check size={14} /> : <Copy size={14} />} label={copied ? 'Copied' : 'Copy'} active={copied} onClick={handleCopy} />
          <ActionButton icon={ttsState === 'loading' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : ttsState === 'playing' ? <VolumeOff size={14} /> : <Volume2 size={14} />} label={ttsState === 'playing' ? 'Stop' : ttsState === 'loading' ? 'Loading...' : 'Read aloud'} active={ttsState === 'playing'} activeColor="#3b82f6" onClick={handleSpeak} />
          <ActionButton icon={<RefreshCw size={14} />} label="Retry" onClick={() => onRetry?.()} />
          <div style={{ width: 1, height: 14, background: '#e2e8f0', marginLeft: 2, marginRight: 2 }} />
          <ActionButton icon={<ThumbsUp size={14} />} label="Good response" active={liked === 'up'} activeColor="#10b981" onClick={() => setLiked((value) => value === 'up' ? null : 'up')} />
          <ActionButton icon={<ThumbsDown size={14} />} label="Bad response" active={liked === 'down'} activeColor="#ef4444" onClick={() => setLiked((value) => value === 'down' ? null : 'down')} />
          <ActionButton icon={<Bookmark size={14} fill={bookmarked ? '#3b82f6' : 'none'} />} label={bookmarked ? 'Bookmarked' : 'Bookmark'} active={bookmarked} activeColor="#3b82f6" onClick={() => setBookmarked((value) => !value)} />
          <div style={{ width: 1, height: 14, background: '#e2e8f0', marginLeft: 2, marginRight: 2 }} />
          {onFork ? <ActionButton icon={<GitBranch size={14} />} label="Fork from here" onClick={onFork} /> : null}
          {onDelete ? <ActionButton icon={<Trash2 size={14} />} label="Delete message" onClick={onDelete} /> : null}
        </div>
      ) : null}

      {isUser && hovered ? (
        <div style={{ display: 'flex', gap: 2, paddingTop: 2, opacity: hovered ? 1 : 0, transition: 'opacity 150ms' }}>
          <ActionButton icon={<Pencil size={13} />} label="Edit message" onClick={() => onEdit?.(visibleContent)} />
          <ActionButton icon={copied ? <Check size={13} /> : <Copy size={13} />} label="Copy" active={copied} onClick={handleCopy} />
          {onDelete ? <ActionButton icon={<Trash2 size={13} />} label="Delete" onClick={onDelete} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleBase);
