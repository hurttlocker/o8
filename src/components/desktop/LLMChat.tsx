'use client';

/**
 * LLMChat — Standalone LLM conversation panel
 *
 * Direct model access with streaming responses, model picker,
 * token counting, and conversation history. This is the revenue
 * surface — free tier uses BYOK keys, pro tier uses managed keys.
 *
 * Design cues: Claude Desktop (clean, spacious, typography-forward)
 * + ChatGPT (model picker dropdown, message actions)
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/230
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Send,
  ChevronDown,
  Square,
  Copy,
  Check,
  Sparkles,
  RotateCcw,
  ThumbsUp,
  ThumbsDown,
  Volume2,
  VolumeOff,
  RefreshCw,
  Pencil,
  Bookmark,
  MoreHorizontal,
  Loader2,
  Brain,
  ChevronRight,
  Search,
  FileText,
  Zap,
  Eye,
  Trash2,
  GitBranch,
  Scissors,
  History,
  Star,
  PanelLeftClose,
  MessageSquare,
  ArrowUp,
  Plus,
} from 'lucide-react';
import { renderLLMMarkdown } from './LLMMarkdown';
import { saveChatHistory, loadChatHistory } from '@/lib/llm/chat-history';

// ── Types ──

export interface ToolCallInfo {
  name: string;
  status: 'calling' | 'running' | 'done';
  args?: Record<string, unknown>;
  preview?: string;
}

export interface SourceInfo {
  title: string;
  url?: string;
  path?: string;
  index?: number;
}

export interface ThinkingStep {
  type: 'thinking' | 'tool' | 'search' | 'reading' | 'analyzing';
  label: string;
  description?: string;
  status: 'active' | 'complete' | 'pending';
  detail?: string; // collapsed content
}

export interface LLMMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  timestamp: number;
  images?: string[]; // data URIs for display
  toolCalls?: ToolCallInfo[];
  sources?: SourceInfo[];
  thinking?: string; // raw thinking text
  thinkingSteps?: ThinkingStep[];
  thinkingDurationMs?: number;
  isError?: boolean; // error messages — excluded from API calls
}

interface ModelOption {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai' | 'google';
  color: string;
  description: string;
}

const MODELS: ModelOption[] = [
  // Google — newest first
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google', color: '#4285f4', description: 'Latest flagship' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', provider: 'google', color: '#4285f4', description: 'Previous gen flagship' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', provider: 'google', color: '#4285f4', description: 'Fast + capable' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', color: '#4285f4', description: 'Stable, GA' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', color: '#4285f4', description: 'Fast + cheap' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', provider: 'google', color: '#4285f4', description: 'Cheapest' },
  // Anthropic
  { id: 'claude-opus-4-6', label: 'Claude Opus', provider: 'anthropic', color: '#e07a3a', description: 'Most capable' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet', provider: 'anthropic', color: '#e07a3a', description: 'Fast + smart' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku', provider: 'anthropic', color: '#e07a3a', description: 'Instant' },
  // OpenAI
  { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai', color: '#10a37f', description: 'Latest OpenAI' },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'openai', color: '#10a37f', description: 'Multimodal' },
];

// ── Subcomponents ──

/** Model picker dropdown — Claude Desktop style */
function ModelPicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: ModelOption;
  onSelect: (m: ModelOption) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState({ bottom: 0, right: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (dropRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Position dropdown above the button using fixed coordinates
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setDropPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          paddingTop: 5,
          paddingBottom: 5,
          paddingLeft: 8,
          paddingRight: 6,
          border: 'none',
          borderRadius: 8,
          background: open ? '#f1f5f9' : 'transparent',
          color: open ? '#1e293b' : '#64748b',
          fontSize: 13,
          fontWeight: 400,
          fontFamily: '-apple-system, system-ui, sans-serif',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'color 150ms, background 150ms',
        }}
        onMouseEnter={(e) => { if (!disabled && !open) { (e.currentTarget).style.color = '#1e293b'; (e.currentTarget).style.background = '#f1f5f9'; } }}
        onMouseLeave={(e) => { if (!open) { (e.currentTarget).style.color = '#64748b'; (e.currentTarget).style.background = 'transparent'; } }}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: selected.color,
          flexShrink: 0,
        }} />
        {selected.label}
        <ChevronDown size={12} style={{ color: '#94a3b8', marginLeft: 2, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </button>

      {open && createPortal(
        <div ref={dropRef} style={{
          position: 'fixed',
          bottom: dropPos.bottom,
          right: dropPos.right,
          zIndex: 9999,
          minWidth: 260,
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 -8px 40px rgba(0, 0, 0, 0.12)',
          animation: 'llmFadeIn 100ms ease-out',
        }}>
          {MODELS.map((m) => (
            <button
              type="button"
              key={m.id}
              onClick={() => { onSelect(m); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                paddingTop: 8,
                paddingRight: 12,
                paddingBottom: 8,
                paddingLeft: 12,
                border: 'none',
                background: m.id === selected.id ? '#f8fafc' : 'transparent',
                color: '#1e293b',
                fontSize: 13,
                fontFamily: '-apple-system, system-ui, sans-serif',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 100ms',
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
              onMouseLeave={(e) => { (e.currentTarget).style.background = m.id === selected.id ? '#f8fafc' : 'transparent'; }}
            >
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: m.color,
                flexShrink: 0,
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{m.label}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{m.description}</div>
              </div>
              {m.id === selected.id && <Check size={14} style={{ color: '#3b82f6' }} />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

/** Single message bubble */
interface MessageBubbleProps {
  message: LLMMessage;
  isLast: boolean;
  onRetry?: () => void;
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  onFork?: () => void;
  onApplyToFile?: (code: string, language: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}

const ACTION_BTN_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  background: 'transparent',
  color: '#cbd5e1',
  cursor: 'pointer',
  borderRadius: 6,
  transition: 'color 150ms, background 150ms',
  padding: 0,
};

function ActionButton({ icon, label, active, activeColor, onClick }: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  activeColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        ...ACTION_BTN_STYLE,
        color: active ? (activeColor || '#10b981') : '#cbd5e1',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget).style.color = '#64748b';
          (e.currentTarget).style.background = '#f1f5f9';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget).style.color = '#cbd5e1';
          (e.currentTarget).style.background = 'transparent';
        }
      }}
    >
      {icon}
    </button>
  );
}

function MessageBubble({ message, isLast, onRetry, onEdit, onDelete, onFork, onApplyToFile, onOpenInCanvas, onRunInTerminal }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<'up' | 'down' | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [ttsState, setTtsState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ttsProgress, setTtsProgress] = useState(0);
  const isUser = message.role === 'user';

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handleSpeak = useCallback(async () => {
    if (ttsState === 'playing') {
      // Stop
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
      // Strip markdown formatting for cleaner speech
      const cleanText = message.content
        .replace(/```[\s\S]*?```/g, ' code block ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, ' image ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#*_~|>/]/g, '')
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ' ')
        .trim();

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText }),
      });

      if (!res.ok) throw new Error('TTS failed');

      const blob = await res.blob();
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
  }, [message.content, ttsState]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        gap: 4,
        animation: isLast ? 'llmFadeIn 200ms ease-out' : undefined,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Message content */}
      <div style={{
        maxWidth: isUser ? '75%' : '90%',
        paddingTop: isUser ? 10 : 16,
        paddingBottom: isUser ? 10 : 16,
        paddingLeft: isUser ? 16 : 0,
        paddingRight: isUser ? 16 : 0,
        borderRadius: isUser ? 18 : 0,
        background: isUser ? '#3b82f6' : message.isError ? 'rgba(239,68,68,0.06)' : 'transparent',
        color: isUser ? 'white' : message.isError ? '#dc2626' : '#1e293b',
        fontSize: 14,
        lineHeight: '1.6',
        fontFamily: '-apple-system, system-ui, sans-serif',
        wordBreak: 'break-word',
        ...(isUser ? { whiteSpace: 'pre-wrap' as const } : {}),
      }}>
        {isUser ? (
          <>
            {message.content}
            {message.images && message.images.length > 0 && (
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginTop: 8,
              }}>
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={img}
                    alt={`Attached ${i + 1}`}
                    style={{
                      maxWidth: 200,
                      maxHeight: 200,
                      borderRadius: 10,
                      objectFit: 'cover',
                      border: '1px solid rgba(255,255,255,0.2)',
                    }}
                  />
                ))}
              </div>
            )}
          </>
        ) : renderLLMMarkdown(message.content, { onApplyToFile, onOpenInCanvas, onRunInTerminal })}
      </div>

      {/* Chain of Thought — shows above message content for completed messages */}
      {!isUser && (message.thinkingSteps || message.thinking) && (
        <ChainOfThought
          steps={message.thinkingSteps || []}
          thinking={message.thinking}
          durationMs={message.thinkingDurationMs}
        />
      )}

      {/* Tool calls display */}
      {!isUser && message.toolCalls && message.toolCalls.length > 0 && !(message.thinkingSteps && message.thinkingSteps.length > 0) && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          maxWidth: '90%',
          marginTop: 4,
        }}>
          {message.toolCalls.map((tc, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 10,
              paddingRight: 10,
              background: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: '-apple-system, system-ui, sans-serif',
              animation: 'llmFadeIn 200ms ease-out',
            }}>
              {/* Status indicator */}
              <div style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: tc.status === 'done' ? '#10b981' : '#3b82f6',
                flexShrink: 0,
                ...(tc.status !== 'done' ? { animation: 'llmDot 1.4s ease-in-out infinite' } : {}),
              }} />
              {/* Tool name + args */}
              <span style={{ color: '#64748b', fontWeight: 500 }}>
                {tc.name === 'search_web' ? '🔍 Searched' :
                 tc.name === 'read_file' ? '📄 Read' :
                 tc.name === 'list_files' ? '📁 Listed' :
                 tc.name === 'search_code' ? '🔎 Searched code' :
                 `🔧 ${tc.name}`}
              </span>
              <span style={{ color: '#94a3b8' }}>
                {tc.name === 'search_web' && tc.args?.query ? `"${tc.args.query}"` :
                 tc.name === 'read_file' && tc.args?.path ? String(tc.args.path) :
                 tc.name === 'search_code' && tc.args?.query ? `"${tc.args.query}"` :
                 tc.name === 'list_files' && tc.args?.path ? String(tc.args.path) :
                 ''}
              </span>
              {tc.status === 'done' && (
                <Check size={12} style={{ color: '#10b981', marginLeft: 'auto' }} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sources */}
      {!isUser && message.sources && message.sources.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          maxWidth: '90%',
          marginTop: 6,
        }}>
          {message.sources.map((src, i) => (
            <a
              key={i}
              href={src.url || '#'}
              target={src.url ? '_blank' : undefined}
              rel="noopener noreferrer"
              onClick={src.path && !src.url ? (e) => {
                e.preventDefault();
                // Could open file in canvas in the future
              } : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 10,
                background: '#f0f9ff',
                border: '1px solid #bae6fd',
                borderRadius: 6,
                fontSize: 11,
                color: '#0369a1',
                textDecoration: 'none',
                fontFamily: '-apple-system, system-ui, sans-serif',
                transition: 'background 100ms',
                cursor: 'pointer',
                animation: 'llmFadeIn 200ms ease-out',
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.background = '#e0f2fe'; }}
              onMouseLeave={(e) => { (e.currentTarget).style.background = '#f0f9ff'; }}
            >
              {src.index && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: '#3b82f6',
                  color: 'white',
                  fontSize: 9,
                  fontWeight: 700,
                  flexShrink: 0,
                }}>
                  {src.index}
                </span>
              )}
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{src.title}</span>
            </a>
          ))}
        </div>
      )}

      {/* Audio progress bar — appears when TTS is loading or playing */}
      {!isUser && ttsState !== 'idle' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 6,
          paddingBottom: 2,
          paddingLeft: 2,
          maxWidth: '90%',
          animation: 'llmFadeIn 200ms ease-out',
        }}>
          {/* Stop button */}
          <button
            type="button"
            onClick={handleSpeak}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: 'none',
              background: ttsState === 'playing' ? '#3b82f6' : '#e2e8f0',
              color: ttsState === 'playing' ? 'white' : '#94a3b8',
              cursor: 'pointer',
              transition: 'all 200ms',
              flexShrink: 0,
            }}
          >
            {ttsState === 'loading' ? (
              <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <Square size={12} fill="currentColor" />
            )}
          </button>

          {/* Progress bar */}
          <div style={{
            flex: 1,
            height: 4,
            background: '#e2e8f0',
            borderRadius: 2,
            overflow: 'hidden',
            minWidth: 100,
          }}>
            {ttsState === 'loading' ? (
              <div style={{
                width: '30%',
                height: '100%',
                background: 'linear-gradient(90deg, #3b82f6, #60a5fa, #3b82f6)',
                borderRadius: 2,
                animation: 'ttsShimmer 1.5s ease-in-out infinite',
              }} />
            ) : (
              <div style={{
                width: `${ttsProgress}%`,
                height: '100%',
                background: '#3b82f6',
                borderRadius: 2,
                transition: 'width 100ms linear',
              }} />
            )}
          </div>

          {/* Waveform dots — animated when playing */}
          {ttsState === 'playing' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 4 }}>
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} style={{
                  width: 3,
                  background: '#3b82f6',
                  borderRadius: 1.5,
                  animation: `ttsWave 0.8s ease-in-out ${i * 0.1}s infinite alternate`,
                }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action bar — assistant messages */}
      {!isUser && message.content && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          paddingTop: 2,
          paddingBottom: 4,
          opacity: hovered || isLast ? 1 : 0,
          transition: 'opacity 150ms',
        }}>
          {/* Meta info */}
          {message.model && (
            <span style={{
              fontSize: 11,
              color: '#94a3b8',
              marginRight: 4,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>
              {message.model}
            </span>
          )}
          {message.tokens && (
            <span style={{
              fontSize: 10,
              color: '#cbd5e1',
              marginRight: 4,
              fontFamily: 'ui-monospace, monospace',
            }}>
              {message.tokens.input + message.tokens.output} tok
            </span>
          )}
          {message.costUsd != null && message.costUsd > 0 && (
            <span style={{
              fontSize: 10,
              color: '#cbd5e1',
              marginRight: 6,
              fontFamily: 'ui-monospace, monospace',
            }}>
              ${message.costUsd.toFixed(4)}
            </span>
          )}

          {/* Divider */}
          <div style={{ width: 1, height: 14, background: '#e2e8f0', marginLeft: 2, marginRight: 2 }} />

          {/* Copy */}
          <ActionButton
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            label={copied ? 'Copied' : 'Copy'}
            active={copied}
            onClick={handleCopy}
          />

          {/* Read aloud / Stop */}
          <ActionButton
            icon={
              ttsState === 'loading' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> :
              ttsState === 'playing' ? <VolumeOff size={14} /> :
              <Volume2 size={14} />
            }
            label={ttsState === 'playing' ? 'Stop' : ttsState === 'loading' ? 'Loading...' : 'Read aloud'}
            active={ttsState === 'playing'}
            activeColor="#3b82f6"
            onClick={handleSpeak}
          />

          {/* Retry / Regenerate */}
          <ActionButton
            icon={<RefreshCw size={14} />}
            label="Retry"
            onClick={() => onRetry?.()}
          />

          {/* Divider */}
          <div style={{ width: 1, height: 14, background: '#e2e8f0', marginLeft: 2, marginRight: 2 }} />

          {/* Thumbs up */}
          <ActionButton
            icon={<ThumbsUp size={14} />}
            label="Good response"
            active={liked === 'up'}
            activeColor="#10b981"
            onClick={() => setLiked(liked === 'up' ? null : 'up')}
          />

          {/* Thumbs down */}
          <ActionButton
            icon={<ThumbsDown size={14} />}
            label="Bad response"
            active={liked === 'down'}
            activeColor="#ef4444"
            onClick={() => setLiked(liked === 'down' ? null : 'down')}
          />

          {/* Bookmark */}
          <ActionButton
            icon={<Bookmark size={14} fill={bookmarked ? '#3b82f6' : 'none'} />}
            label={bookmarked ? 'Bookmarked' : 'Bookmark'}
            active={bookmarked}
            activeColor="#3b82f6"
            onClick={() => setBookmarked(!bookmarked)}
          />

          {/* Divider */}
          <div style={{ width: 1, height: 14, background: '#e2e8f0', marginLeft: 2, marginRight: 2 }} />

          {/* Fork conversation from here */}
          {onFork && (
            <ActionButton
              icon={<GitBranch size={14} />}
              label="Fork from here"
              onClick={() => onFork()}
            />
          )}

          {/* Delete this exchange */}
          {onDelete && (
            <ActionButton
              icon={<Trash2 size={14} />}
              label="Delete message"
              onClick={() => onDelete()}
            />
          )}
        </div>
      )}

      {/* Action bar — user messages (edit only, on hover) */}
      {isUser && hovered && (
        <div style={{
          display: 'flex',
          gap: 2,
          paddingTop: 2,
          opacity: hovered ? 1 : 0,
          transition: 'opacity 150ms',
        }}>
          <ActionButton
            icon={<Pencil size={13} />}
            label="Edit message"
            onClick={() => onEdit?.(message.content)}
          />
          <ActionButton
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
            label="Copy"
            active={copied}
            onClick={handleCopy}
          />
          {onDelete && (
            <ActionButton
              icon={<Trash2 size={13} />}
              label="Delete"
              onClick={() => onDelete()}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Streaming dots indicator */
// ── Chain of Thought Component ──

function ChainOfThought({
  steps,
  thinking,
  durationMs,
  isLive = false,
}: {
  steps: ThinkingStep[];
  thinking?: string;
  durationMs?: number;
  isLive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 0 && !thinking) return null;

  const completedCount = steps.filter(s => s.status === 'complete').length;
  const activeStep = steps.find(s => s.status === 'active');
  const durationSec = durationMs ? (durationMs / 1000).toFixed(1) : null;

  return (
    <div style={{
      maxWidth: '90%',
      marginBottom: 8,
      animation: 'llmFadeIn 200ms ease-out',
    }}>
      {/* Header — click to expand */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
          background: isLive ? 'linear-gradient(135deg, #f8fafc 0%, #f0f9ff 100%)' : '#f8fafc',
          border: `1px solid ${isLive ? '#bae6fd' : '#e2e8f0'}`,
          borderRadius: 10,
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
          transition: 'all 150ms ease',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget).style.background = '#f0f9ff';
          (e.currentTarget).style.borderColor = '#93c5fd';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget).style.background = isLive ? 'linear-gradient(135deg, #f8fafc 0%, #f0f9ff 100%)' : '#f8fafc';
          (e.currentTarget).style.borderColor = isLive ? '#bae6fd' : '#e2e8f0';
        }}
      >
        {/* Brain icon */}
        <div style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          background: isLive ? 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)' : '#e2e8f0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          ...(isLive ? { animation: 'llmDot 2s ease-in-out infinite' } : {}),
        }}>
          <Brain size={13} style={{ color: isLive ? 'white' : '#64748b' }} />
        </div>

        {/* Label */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 500,
            color: '#1e293b',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {isLive && activeStep ? (
              <span>{activeStep.label}</span>
            ) : (
              <span>Thought for {durationSec ? `${durationSec}s` : `${completedCount} step${completedCount !== 1 ? 's' : ''}`}</span>
            )}
          </div>
          {isLive && (
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>
              {completedCount} step{completedCount !== 1 ? 's' : ''} completed
            </div>
          )}
        </div>

        {/* Progress dots */}
        {isLive && (
          <div style={{ display: 'flex', gap: 3, marginRight: 4 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: '#3b82f6',
                animation: `llmDot 1.4s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        )}

        {/* Chevron */}
        <ChevronRight
          size={14}
          style={{
            color: '#94a3b8',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform 200ms ease',
            flexShrink: 0,
          }}
        />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div style={{
          marginTop: 4,
          paddingLeft: 12,
          borderLeft: '2px solid #e2e8f0',
          marginLeft: 23,
          animation: 'llmFadeIn 200ms ease-out',
        }}>
          {/* Steps */}
          {steps.map((step, i) => {
            const StepIcon = step.type === 'search' ? Search :
                            step.type === 'reading' ? FileText :
                            step.type === 'analyzing' ? Zap :
                            step.type === 'tool' ? Eye :
                            Brain;
            return (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                paddingTop: 8,
                paddingBottom: 8,
                animation: `llmFadeIn 200ms ease-out ${i * 50}ms both`,
              }}>
                {/* Status dot */}
                <div style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 1,
                  background: step.status === 'complete' ? '#dcfce7' :
                             step.status === 'active' ? '#dbeafe' : '#f1f5f9',
                  border: `1px solid ${
                    step.status === 'complete' ? '#86efac' :
                    step.status === 'active' ? '#93c5fd' : '#e2e8f0'
                  }`,
                }}>
                  {step.status === 'complete' ? (
                    <Check size={10} style={{ color: '#16a34a' }} />
                  ) : step.status === 'active' ? (
                    <StepIcon size={10} style={{ color: '#3b82f6', animation: 'llmDot 1.4s ease-in-out infinite' }} />
                  ) : (
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#cbd5e1' }} />
                  )}
                </div>

                {/* Step content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: step.status === 'active' ? '#1e40af' : '#374151',
                  }}>
                    {step.label}
                  </div>
                  {step.description && (
                    <div style={{
                      fontSize: 11,
                      color: '#94a3b8',
                      marginTop: 2,
                      lineHeight: '1.4',
                    }}>
                      {step.description}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Raw thinking text (collapsed by default) */}
          {thinking && (
            <ThinkingText text={thinking} />
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingText({ text }: { text: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div style={{ marginTop: 4, marginBottom: 4 }}>
      <button
        type="button"
        onClick={() => setShowRaw(!showRaw)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          border: 'none',
          background: 'transparent',
          color: '#94a3b8',
          fontSize: 11,
          cursor: 'pointer',
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 0,
          paddingRight: 0,
        }}
      >
        <ChevronRight size={10} style={{
          transform: showRaw ? 'rotate(90deg)' : 'rotate(0)',
          transition: 'transform 200ms ease',
        }} />
        View raw thinking
      </button>
      {showRaw && (
        <div style={{
          marginTop: 4,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 10,
          paddingRight: 10,
          background: '#f8fafc',
          borderRadius: 6,
          fontSize: 11,
          color: '#64748b',
          lineHeight: '1.6',
          fontFamily: 'ui-monospace, monospace',
          maxHeight: 200,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          animation: 'llmFadeIn 200ms ease-out',
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

// ── Slash Commands ──

const SLASH_COMMANDS = [
  { command: '/web', label: 'Search the web', description: 'Find current information online', icon: '🌐', prefix: 'Search the web for: ' },
  { command: '/code', label: 'Search codebase', description: 'Find functions, imports, patterns', icon: '🔎', prefix: 'Search this codebase for: ' },
  { command: '/file', label: 'Read a file', description: 'Read and analyze a specific file', icon: '📄', prefix: 'Read and explain the file: ' },
  { command: '/think', label: 'Think step by step', description: 'Reason through a complex problem', icon: '🧠', prefix: 'Think step by step about this: ' },
  { command: '/review', label: 'Code review', description: 'Review code for bugs and improvements', icon: '🔍', prefix: 'Review this code for bugs, improvements, and best practices: ' },
  { command: '/explain', label: 'Explain this', description: 'Break down complex code or concepts', icon: '💡', prefix: 'Explain in detail: ' },
  { command: '/test', label: 'Write tests', description: 'Generate test cases', icon: '🧪', prefix: 'Write comprehensive tests for: ' },
  { command: '/fix', label: 'Fix this', description: 'Debug and fix an issue', icon: '🔧', prefix: 'Debug and fix this issue: ' },
  { command: '/issue', label: 'Create issue', description: 'File a GitHub issue from chat context', icon: '📋', prefix: 'Create a GitHub issue for: ' },
  { command: '/pr', label: 'Create PR', description: 'Open a pull request from current changes', icon: '🔀', prefix: 'Create a pull request with these changes: ' },
];

// ── Follow-up question generation ──

async function generateFollowUps(
  lastResponse: string,
  model: { id: string; label: string; provider: string },
  userQuestion: string,
): Promise<string[]> {
  try {
    const res = await fetch('/api/v2/proxy/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        provider: model.provider,
        messages: [
          {
            role: 'system',
            content: 'Generate exactly 3 brief follow-up questions the user might ask next based on this conversation. Return ONLY the questions, one per line, no numbering, no bullets, no quotes. Keep each under 60 characters. Be specific and insightful, not generic.',
          },
          {
            role: 'user',
            content: `User asked: "${userQuestion.slice(0, 200)}"\n\nAssistant responded: "${lastResponse.slice(0, 500)}"\n\nGenerate 3 follow-up questions:`,
          },
        ],
      }),
    });

    if (!res.ok) return [];

    // Parse the SSE stream
    const reader = res.body?.getReader();
    if (!reader) return [];
    const decoder = new TextDecoder();
    let content = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content') content += parsed.text;
          } catch { /* ignore */ }
        }
      }
    }

    // Parse into individual questions
    return content
      .split('\n')
      .map(l => l.replace(/^[\d\.\-\*\)]+\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(l => l.length > 5 && l.length < 100 && l.includes(' '))
      .slice(0, 3);
  } catch {
    return [];
  }
}

// ── Suggested prompts for empty state ──

const SUGGESTED_PROMPTS = [
  { icon: '💡', text: 'Explain this codebase architecture', description: 'Get a high-level overview of how the project is structured' },
  { icon: '🔍', text: 'Find all TODO comments in the code', description: 'Search for technical debt and pending work' },
  { icon: '📝', text: 'Write a README for this project', description: 'Generate documentation from the codebase' },
  { icon: '🐛', text: 'Review the most recent changes', description: 'Analyze recent commits for potential issues' },
  { icon: '🧪', text: 'Suggest tests for the auth module', description: 'Generate test cases for critical paths' },
  { icon: '⚡', text: 'What could be optimized here?', description: 'Find performance improvements in the codebase' },
];

function StreamingIndicator() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      paddingTop: 16,
      paddingBottom: 8,
    }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#94a3b8',
            animation: `llmDot 1.4s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

// ── Main Component ──

export default function LLMChat({ tabId, onOpenInCanvas, onRunInTerminal, onOpenHistoryChat }: {
  tabId: string;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string) => void;
}) {
  const [messages, setMessages] = useState<LLMMessage[]>([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState<ModelOption>(MODELS[0]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [modelResolved, setModelResolved] = useState(false);
  const [fileSuggestions, setFileSuggestions] = useState<{ path: string; name: string }[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [filePickerIndex, setFilePickerIndex] = useState(0);
  const [attachedImages, setAttachedImages] = useState<{ name: string; dataUri: string }[]>([]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]);
  const [activeThinking, setActiveThinking] = useState<{ steps: ThinkingStep[]; thinking: string } | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [followUpsLoading, setFollowUpsLoading] = useState(false);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [approvedToolsSet, setApprovedToolsSet] = useState<Set<string>>(new Set());
  const [pendingApproval, setPendingApproval] = useState<{
    name: string;
    args: Record<string, unknown>;
    summary: string;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyItems, setHistoryItems] = useState<{
    tabId: string; title: string; preview: string; messageCount: number;
    model: string; savedAt: string; modifiedAt: string; starred: boolean;
  }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [applyModal, setApplyModal] = useState<{ code: string; language: string } | null>(null);
  const [applyPath, setApplyPath] = useState('');
  const [applyStatus, setApplyStatus] = useState<'idle' | 'applying' | 'done' | 'error'>('idle');
  const [applyFileSuggestions, setApplyFileSuggestions] = useState<{ path: string }[]>([]);
  const [applyFileIndex, setApplyFileIndex] = useState(0);
  const applySearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply code to a file
  const handleApplyToFile = useCallback((code: string, language: string) => {
    setApplyModal({ code, language });
    setApplyPath('');
    setApplyStatus('idle');
    setApplyFileSuggestions([]);
  }, []);

  // Search files for apply modal
  const searchApplyFiles = useCallback((query: string) => {
    if (applySearchTimeout.current) clearTimeout(applySearchTimeout.current);
    if (!query.trim()) {
      setApplyFileSuggestions([]);
      return;
    }
    applySearchTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setApplyFileSuggestions(data.files ?? []);
          setApplyFileIndex(0);
        }
      } catch { /* ignore */ }
    }, 100);
  }, []);

  // Load chat history list
  const loadHistory = useCallback(async (search?: string) => {
    setHistoryLoading(true);
    try {
      const url = search
        ? `/api/v2/chat-history/list?q=${encodeURIComponent(search)}`
        : '/api/v2/chat-history/list';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setHistoryItems(data.conversations ?? []);
      }
    } catch { /* ignore */ }
    setHistoryLoading(false);
  }, []);

  // Toggle star
  const toggleStar = useCallback(async (histTabId: string, starred: boolean) => {
    try {
      await fetch('/api/v2/chat-history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabId: histTabId, starred }),
      });
      setHistoryItems(prev => prev.map(h =>
        h.tabId === histTabId ? { ...h, starred } : h
      ));
    } catch { /* ignore */ }
  }, []);

  // Delete a history entry
  const deleteHistory = useCallback(async (histTabId: string) => {
    try {
      await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(histTabId)}`, { method: 'DELETE' });
      setHistoryItems(prev => prev.filter(h => h.tabId !== histTabId));
    } catch { /* ignore */ }
  }, []);

  // Open history panel
  useEffect(() => {
    if (historyOpen) loadHistory();
  }, [historyOpen, loadHistory]);

  const doApply = useCallback(async () => {
    if (!applyModal || !applyPath.trim()) return;
    setApplyStatus('applying');
    try {
      const res = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: applyPath.trim(), content: applyModal.code }),
      });
      if (res.ok) {
        setApplyStatus('done');
        setTimeout(() => { setApplyModal(null); setApplyStatus('idle'); }, 1500);
      } else {
        setApplyStatus('error');
      }
    } catch {
      setApplyStatus('error');
    }
  }, [applyModal, applyPath]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted messages + auto-select model
  useEffect(() => {
    if (modelResolved) return;
    (async () => {
      // Load saved chat history
      const saved = await loadChatHistory(tabId);
      if (saved?.messages?.length) {
        setMessages(saved.messages);
        // Restore model if saved
        if (saved.model) {
          const savedModel = MODELS.find(m => m.id === saved.model);
          if (savedModel) {
            setModel(savedModel);
            setModelResolved(true);
            return;
          }
        }
      }
      // Auto-select model based on configured API keys
      try {
        const res = await fetch('/api/v2/keys');
        if (res.ok) {
          const data = await res.json();
          const configured = new Set(
            (data.providers ?? [])
              .filter((p: { configured: boolean }) => p.configured)
              .map((p: { id: string }) => p.id)
          );
          const match = MODELS.find(m => configured.has(m.provider));
          if (match) setModel(match);
        }
      } catch { /* ignore */ }
      setModelResolved(true);
    })();
  }, [modelResolved, tabId]);

  // Auto-save chat history (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!modelResolved || messages.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChatHistory(tabId, messages, model.id);
    }, 1000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [messages, model.id, tabId, modelResolved]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamContent]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, [tabId]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+L — focus chat input
      if (meta && e.key === 'l') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }

      // Escape — cancel streaming
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault();
        abortRef.current?.abort();
        return;
      }

      // Up Arrow in empty input — edit last message
      if (e.key === 'ArrowUp' && !e.shiftKey && document.activeElement === inputRef.current) {
        const val = inputRef.current?.value ?? '';
        if (val === '') {
          e.preventDefault();
          const lastUser = [...messages].reverse().find(m => m.role === 'user');
          if (lastUser) {
            setInput(lastUser.content);
            setMessages(messages.filter(m => m.id !== lastUser.id));
            requestAnimationFrame(() => {
              if (inputRef.current) {
                inputRef.current.style.height = 'auto';
                inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
                inputRef.current.selectionStart = inputRef.current.value.length;
                inputRef.current.selectionEnd = inputRef.current.value.length;
              }
            });
          }
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isStreaming, messages]);

  // Auto-resize textarea + @file detection
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
    }

    // Detect @file pattern
    const cursorPos = inputRef.current?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@([\w./\-]*)$/);

    if (atMatch && atMatch[1].length >= 1) {
      const query = atMatch[1];
      if (fileSearchTimeout.current) clearTimeout(fileSearchTimeout.current);
      fileSearchTimeout.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`);
          if (res.ok) {
            const data = await res.json();
            setFileSuggestions(data.files ?? []);
            setShowFilePicker(data.files?.length > 0);
            setFilePickerIndex(0);
          }
        } catch { /* ignore */ }
      }, 150);
    } else {
      setShowFilePicker(false);
      setFileSuggestions([]);
    }

    // Detect /slash commands
    if (value.startsWith('/') && !value.includes(' ')) {
      const query = value.toLowerCase();
      const matches = SLASH_COMMANDS.filter(c => c.command.startsWith(query));
      setShowSlashPicker(matches.length > 0 && value.length <= 10);
      setSlashIndex(0);
    } else {
      setShowSlashPicker(false);
    }
  }, []);

  // Handle image paste/drop
  const handleImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (attachedImages.length >= 4) return; // max 4 images
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
      setAttachedImages(prev => [...prev, { name: file.name, dataUri }]);
    };
    reader.readAsDataURL(file);
  }, [attachedImages.length]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) handleImageFile(file);
        return;
      }
    }
  }, [handleImageFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      handleImageFile(files[i]);
    }
  }, [handleImageFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // Select a file from the autocomplete
  const handleFileSelect = useCallback((filePath: string) => {
    // Replace the @query with the full path
    const cursorPos = inputRef.current?.selectionStart ?? input.length;
    const textBeforeCursor = input.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@[\w./\-]*$/);
    if (atMatch) {
      const before = textBeforeCursor.slice(0, atMatch.index);
      const after = input.slice(cursorPos);
      setInput(before + '@' + filePath + ' ' + after);
    }
    if (!attachedFiles.includes(filePath)) {
      setAttachedFiles(prev => [...prev, filePath]);
    }
    setShowFilePicker(false);
    setFileSuggestions([]);
    inputRef.current?.focus();
  }, [input, attachedFiles]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Extract @file references from the message
    const fileRefs = text.match(/@([\w./\-]+)/g)?.map(r => r.slice(1)) ?? [];
    // Combine with explicitly attached files
    const allFiles = [...new Set([...attachedFiles, ...fileRefs])];

    // Fetch file contents if any files referenced
    let fileContext = '';
    if (allFiles.length > 0) {
      try {
        const res = await fetch('/api/v2/context/files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: allFiles }),
        });
        if (res.ok) {
          const data = await res.json();
          const parts = (data.files ?? [])
            .filter((f: { content: string; error?: string }) => f.content && !f.error)
            .map((f: { path: string; content: string; truncated: boolean }) =>
              `### File: ${f.path}${f.truncated ? ' (truncated)' : ''}\n\`\`\`\n${f.content}\n\`\`\``
            );
          if (parts.length > 0) {
            fileContext = '\n\n## Attached Files\n' + parts.join('\n\n');
          }
        }
      } catch { /* ignore */ }
    }

    // Build the user message (display version — images shown inline, file contents hidden)
    const userMsg: LLMMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      images: attachedImages.length > 0 ? attachedImages.map(img => img.dataUri) : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setAttachedFiles([]);
    setAttachedImages([]);
    setFollowUps([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    // Build image markdown for model
    const imageMarkdown = attachedImages.map((img, i) =>
      `![Image ${i + 1}](${img.dataUri})`
    ).join('\n');

    // Build the actual message sent to the model (includes file contents + images)
    const messageForModel = [text, fileContext, imageMarkdown].filter(Boolean).join('\n\n');

    // Start streaming
    setIsStreaming(true);
    setStreamContent('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Filter messages for API: skip error messages, empty content, and limit context
      const cleanMessages = messages
        .filter((m) => {
          // Skip error/system messages (they poison the conversation)
          if (m.isError) return false;
          if (m.content.startsWith('Error: ')) return false;
          if (m.content.startsWith('Action cancelled:')) return false;
          // Skip empty messages
          if (!m.content.trim()) return false;
          return true;
        })
        .map((m) => ({ role: m.role, content: m.content }));

      // Keep last 40 messages max to avoid context overflow
      const recentMessages = cleanMessages.length > 40
        ? cleanMessages.slice(-40)
        : cleanMessages;

      const reqBody = JSON.stringify({
        model: model.id,
        provider: model.provider,
        messages: [
          ...recentMessages,
          { role: 'user', content: messageForModel },
        ],
        approvedTools: [...approvedToolsSet],
      });

      // Fetch with automatic retry on transient failures (dev server HMR, network blip)
      let res: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await fetch('/api/v2/proxy/llm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: reqBody,
            signal: controller.signal,
          });
          break; // Success — exit retry loop
        } catch (fetchErr) {
          if (attempt === 0 && !controller.signal.aborted) {
            // First failure — wait 1s and retry (likely dev server recompiling)
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          throw fetchErr;
        }
      }

      if (!res) throw new Error('Load failed');

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Stream the response
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let fullContent = '';
      let tokens: { input: number; output: number } | undefined;
      let costUsd: number | undefined;
      const toolCalls: ToolCallInfo[] = [];
      const sources: SourceInfo[] = [];
      let thinkingText = '';
      const thinkingSteps: ThinkingStep[] = [];
      const thinkingStartTime = Date.now();
      let isThinking = false;
      setActiveToolCalls([]);
      setActiveThinking(null);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // Parse SSE events
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'thinking') {
                thinkingText += parsed.text;
                if (!isThinking) {
                  isThinking = true;
                  thinkingSteps.push({
                    type: 'thinking',
                    label: 'Reasoning through the problem...',
                    status: 'active',
                  });
                }
                // Parse thinking text for structure (look for step-like patterns)
                const lines = parsed.text.split('\n').filter((l: string) => l.trim());
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.length > 10 && (
                    trimmed.startsWith('I need to') ||
                    trimmed.startsWith('Let me') ||
                    trimmed.startsWith('First,') ||
                    trimmed.startsWith('Now') ||
                    trimmed.startsWith('The ') ||
                    trimmed.startsWith('This ')
                  )) {
                    // Update the active step label
                    const active = thinkingSteps.find(s => s.status === 'active');
                    if (active) {
                      active.label = trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
                    }
                  }
                }
                setActiveThinking({ steps: [...thinkingSteps], thinking: thinkingText });
              } else if (parsed.type === 'content') {
                // First content after thinking = thinking is done
                if (isThinking) {
                  isThinking = false;
                  thinkingSteps.forEach(s => { if (s.status === 'active') s.status = 'complete'; });
                  setActiveThinking({ steps: [...thinkingSteps], thinking: thinkingText });
                }
                fullContent += parsed.text;
                setStreamContent(fullContent);
              } else if (parsed.type === 'usage') {
                tokens = { input: parsed.inputTokens, output: parsed.outputTokens };
                costUsd = parsed.costUsd;
              } else if (parsed.type === 'tool_call') {
                const existing = toolCalls.find(t => t.name === parsed.name);
                if (existing) {
                  existing.status = parsed.status;
                  existing.args = parsed.args ?? existing.args;
                } else {
                  toolCalls.push({ name: parsed.name, status: parsed.status, args: parsed.args });
                }
                setActiveToolCalls([...toolCalls]);
                // Add tool call as a thinking step
                const toolLabel = parsed.name === 'search_web' ? `Searching "${parsed.args?.query || ''}"` :
                                  parsed.name === 'read_file' ? `Reading ${parsed.args?.path || ''}` :
                                  parsed.name === 'search_code' ? `Searching code for "${parsed.args?.query || ''}"` :
                                  parsed.name === 'list_files' ? `Listing ${parsed.args?.path || ''}` :
                                  `Running ${parsed.name}`;
                thinkingSteps.push({
                  type: parsed.name === 'search_web' || parsed.name === 'search_code' ? 'search' :
                        parsed.name === 'read_file' ? 'reading' : 'tool',
                  label: toolLabel,
                  status: 'active',
                });
                setActiveThinking({ steps: [...thinkingSteps], thinking: thinkingText });
              } else if (parsed.type === 'tool_result') {
                const existing = toolCalls.find(t => t.name === parsed.name);
                if (existing) {
                  existing.status = 'done';
                  existing.preview = parsed.preview;
                }
                setActiveToolCalls([...toolCalls]);
                // Mark matching thinking step as complete
                const toolStep = [...thinkingSteps].reverse().find(s => s.status === 'active' && s.type !== 'thinking');
                if (toolStep) toolStep.status = 'complete';
                setActiveThinking({ steps: [...thinkingSteps], thinking: thinkingText });
              } else if (parsed.type === 'approval_required') {
                setPendingApproval({
                  name: parsed.name,
                  args: parsed.args,
                  summary: parsed.summary,
                });
              } else if (parsed.type === 'sources') {
                sources.push(...(parsed.sources ?? []));
              } else if (parsed.type === 'error') {
                throw new Error(parsed.message);
              }
            } catch (e) {
              if (e instanceof Error && e.message !== 'Unexpected') {
                if ((e as Error).name !== 'SyntaxError') throw e;
              }
              // Non-JSON line, might be raw text
              if (!line.startsWith('data: [') && !line.startsWith('data: {')) {
                fullContent += data;
                setStreamContent(fullContent);
              }
            }
          }
        }
      }

      // Add assistant message
      const assistantMsg: LLMMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        content: fullContent,
        model: model.label,
        tokens,
        costUsd,
        timestamp: Date.now(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        sources: sources.length > 0 ? sources : undefined,
        thinking: thinkingText || undefined,
        thinkingSteps: thinkingSteps.length > 0 ? thinkingSteps.map(s => ({ ...s, status: 'complete' as const })) : undefined,
        thinkingDurationMs: thinkingSteps.length > 0 || thinkingText ? Date.now() - thinkingStartTime : undefined,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setStreamContent('');
      setActiveThinking(null);

      // Generate follow-up suggestions (async, non-blocking)
      if (fullContent.length > 20) {
        setFollowUps([]);
        setFollowUpsLoading(true);
        generateFollowUps(fullContent, model, text).then(suggestions => {
          setFollowUps(suggestions);
          setFollowUpsLoading(false);
        }).catch(() => setFollowUpsLoading(false));
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // User cancelled
        if (streamContent) {
          setMessages((prev) => [...prev, {
            id: `asst-${Date.now()}`,
            role: 'assistant',
            content: streamContent + '\n\n*[stopped]*',
            model: model.label,
            timestamp: Date.now(),
          }]);
        }
      } else {
        setMessages((prev) => [...prev, {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${(err as Error).message}`,
          timestamp: Date.now(),
          isError: true,
        }]);
      }
      setStreamContent('');
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming, messages, model, streamContent]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // File picker navigation
    if (showFilePicker && fileSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFilePickerIndex(prev => Math.min(prev + 1, fileSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFilePickerIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        handleFileSelect(fileSuggestions[filePickerIndex].path);
        return;
      }
      if (e.key === 'Escape') {
        setShowFilePicker(false);
        return;
      }
    }

    // Slash command picker navigation
    if (showSlashPicker) {
      const filtered = SLASH_COMMANDS.filter(c => c.command.startsWith(input.toLowerCase()));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex(prev => Math.min(prev + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const cmd = filtered[slashIndex];
        if (cmd) {
          setInput(cmd.prefix);
          setShowSlashPicker(false);
          if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        setShowSlashPicker(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showFilePicker, fileSuggestions, filePickerIndex, handleFileSelect, showSlashPicker, input, slashIndex]);

  const isEmpty = messages.length === 0 && !isStreaming;

  // Group history by date
  const groupedHistory = (() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const thisWeek = today - 7 * 86400000;

    const groups: { label: string; items: typeof historyItems }[] = [];
    const starred = historyItems.filter(h => h.starred);
    const todayItems = historyItems.filter(h => !h.starred && new Date(h.modifiedAt).getTime() >= today);
    const yesterdayItems = historyItems.filter(h => !h.starred && new Date(h.modifiedAt).getTime() >= yesterday && new Date(h.modifiedAt).getTime() < today);
    const weekItems = historyItems.filter(h => !h.starred && new Date(h.modifiedAt).getTime() >= thisWeek && new Date(h.modifiedAt).getTime() < yesterday);
    const olderItems = historyItems.filter(h => !h.starred && new Date(h.modifiedAt).getTime() < thisWeek);

    if (starred.length) groups.push({ label: '⭐ Starred', items: starred });
    if (todayItems.length) groups.push({ label: 'Today', items: todayItems });
    if (yesterdayItems.length) groups.push({ label: 'Yesterday', items: yesterdayItems });
    if (weekItems.length) groups.push({ label: 'This Week', items: weekItems });
    if (olderItems.length) groups.push({ label: 'Older', items: olderItems });
    return groups;
  })();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      height: '100%',
      background: '#ffffff',
      fontFamily: '-apple-system, system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      {/* ── History Sidebar ── */}
      <div style={{
        width: historyOpen ? 260 : 0,
        minWidth: historyOpen ? 260 : 0,
        borderRight: historyOpen ? '1px solid #f1f5f9' : 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 200ms ease, min-width 200ms ease',
        background: '#fafbfc',
      }}>
        {historyOpen && (
          <>
            {/* Sidebar header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 14,
              paddingRight: 10,
              borderBottom: '1px solid #f1f5f9',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>History</span>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  border: 'none',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  paddingTop: 4,
                  paddingBottom: 4,
                  paddingLeft: 4,
                  paddingRight: 4,
                  borderRadius: 6,
                }}
              >
                <PanelLeftClose size={14} />
              </button>
            </div>

            {/* Search */}
            <div style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10 }}>
              <input
                type="text"
                value={historySearch}
                onChange={(e) => {
                  setHistorySearch(e.target.value);
                  loadHistory(e.target.value || undefined);
                }}
                placeholder="Search conversations..."
                style={{
                  width: '100%',
                  paddingTop: 7,
                  paddingBottom: 7,
                  paddingLeft: 10,
                  paddingRight: 10,
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  fontSize: 12,
                  outline: 'none',
                  boxSizing: 'border-box',
                  background: 'white',
                  transition: 'border-color 150ms',
                }}
                onFocus={(e) => { (e.currentTarget).style.borderColor = '#3b82f6'; }}
                onBlur={(e) => { (e.currentTarget).style.borderColor = '#e2e8f0'; }}
              />
            </div>

            {/* Conversation list */}
            <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
              {historyLoading ? (
                <div style={{ textAlign: 'center', paddingTop: 20, color: '#94a3b8', fontSize: 12 }}>
                  Loading...
                </div>
              ) : historyItems.length === 0 ? (
                <div style={{ textAlign: 'center', paddingTop: 20, color: '#94a3b8', fontSize: 12 }}>
                  {historySearch ? 'No matches' : 'No saved conversations'}
                </div>
              ) : (
                groupedHistory.map(group => (
                  <div key={group.label}>
                    <div style={{
                      paddingTop: 10,
                      paddingBottom: 4,
                      paddingLeft: 14,
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#94a3b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}>
                      {group.label}
                    </div>
                    {group.items.map(conv => (
                      <div
                        key={conv.tabId}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          paddingTop: 8,
                          paddingBottom: 8,
                          paddingLeft: 14,
                          paddingRight: 10,
                          cursor: 'pointer',
                          transition: 'background 100ms',
                          borderRadius: 6,
                          marginLeft: 4,
                          marginRight: 4,
                        }}
                        onMouseEnter={(e) => { (e.currentTarget).style.background = '#f1f5f9'; }}
                        onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                        onClick={() => {
                          if (onOpenHistoryChat) {
                            onOpenHistoryChat(conv.tabId, conv.title);
                          }
                        }}
                      >
                        <MessageSquare size={13} style={{ color: '#94a3b8', marginTop: 2, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: '#1e293b',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {conv.title}
                          </div>
                          <div style={{
                            fontSize: 11,
                            color: '#94a3b8',
                            marginTop: 2,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {conv.messageCount} msgs · {conv.model.split('/').pop()}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleStar(conv.tabId, !conv.starred);
                            }}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              paddingTop: 2,
                              paddingBottom: 2,
                              paddingLeft: 2,
                              paddingRight: 2,
                              color: conv.starred ? '#f59e0b' : '#cbd5e1',
                            }}
                            title={conv.starred ? 'Unstar' : 'Star'}
                          >
                            <Star size={12} fill={conv.starred ? '#f59e0b' : 'none'} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteHistory(conv.tabId);
                            }}
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              paddingTop: 2,
                              paddingBottom: 2,
                              paddingLeft: 2,
                              paddingRight: 2,
                              color: '#cbd5e1',
                            }}
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Main Chat Column ── */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        height: '100%',
      }}>
      {/* CSS animations */}
      <style>{`
        @keyframes llmFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes llmDot {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes ttsShimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
        @keyframes ttsWave {
          0% { height: 4px; }
          100% { height: 16px; }
        }
      `}</style>

      {/* Top bar — model picker */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 24,
        paddingRight: 24,
        borderBottom: '1px solid #f1f5f9',
      }}>
        {/* History toggle */}
        <button
          type="button"
          onClick={() => setHistoryOpen(!historyOpen)}
          title={historyOpen ? 'Close history' : 'Chat history'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 8,
            paddingRight: 8,
            border: 'none',
            borderRadius: 8,
            background: historyOpen ? '#f1f5f9' : 'transparent',
            color: historyOpen ? '#3b82f6' : '#94a3b8',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
            transition: 'all 150ms',
          }}
          onMouseEnter={(e) => { if (!historyOpen) (e.currentTarget).style.background = '#f8fafc'; }}
          onMouseLeave={(e) => { if (!historyOpen) (e.currentTarget).style.background = 'transparent'; }}
        >
          <History size={14} />
        </button>

        <div style={{ flex: 1 }} />

        {/* Token/message counter */}
        {messages.length > 0 && (
          <span style={{
            fontSize: 11,
            color: '#94a3b8',
            fontFamily: 'ui-monospace, monospace',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}>
            <span>{messages.length} msg{messages.length !== 1 ? 's' : ''}</span>
            {(() => {
              const totalTokens = messages.reduce((sum, m) => sum + (m.tokens?.input ?? 0) + (m.tokens?.output ?? 0), 0);
              const totalCost = messages.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
              return totalTokens > 0 ? (
                <>
                  <span style={{ color: '#cbd5e1' }}>·</span>
                  <span>{totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens} tokens</span>
                  {totalCost > 0 && (
                    <>
                      <span style={{ color: '#cbd5e1' }}>·</span>
                      <span>${totalCost.toFixed(4)}</span>
                    </>
                  )}
                </>
              ) : null;
            })()}
          </span>
        )}

        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => { setMessages([]); setStreamContent(''); setFollowUps([]); }}
            title="New conversation"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 8,
              paddingRight: 8,
              border: 'none',
              background: 'transparent',
              color: '#94a3b8',
              fontSize: 12,
              cursor: 'pointer',
              borderRadius: 6,
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => { (e.currentTarget).style.color = '#64748b'; }}
            onMouseLeave={(e) => { (e.currentTarget).style.color = '#94a3b8'; }}
          >
            <RotateCcw size={13} />
            New
          </button>
        )}
      </div>

      {/* Message area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: isEmpty ? 0 : 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        {/* Empty state — beautiful onboarding */}
        {isEmpty && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 32,
            animation: 'llmFadeIn 400ms ease-out',
          }}>
            {/* Greeting */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
            }}>
              <div style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(59, 130, 246, 0.2)',
              }}>
                <Sparkles size={24} style={{ color: 'white' }} />
              </div>
              <div style={{
                fontSize: 24,
                fontWeight: 600,
                color: '#0f172a',
                letterSpacing: '-0.02em',
              }}>
                What can I help you build?
              </div>
              <div style={{
                fontSize: 14,
                color: '#94a3b8',
                textAlign: 'center',
                maxWidth: 400,
                lineHeight: '1.5',
              }}>
                Chat with {model.label} — with full workspace context, file access, and code search built in.
              </div>
            </div>

            {/* Suggested prompts grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
              maxWidth: 560,
              width: '100%',
            }}>
              {SUGGESTED_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setInput(prompt.text);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    paddingTop: 14,
                    paddingBottom: 14,
                    paddingLeft: 14,
                    paddingRight: 14,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 150ms ease',
                    animation: `llmFadeIn 400ms ease-out ${100 + i * 50}ms both`,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget).style.borderColor = '#3b82f6';
                    (e.currentTarget).style.background = '#f0f9ff';
                    (e.currentTarget).style.transform = 'translateY(-1px)';
                    (e.currentTarget).style.boxShadow = '0 2px 8px rgba(59, 130, 246, 0.08)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget).style.borderColor = '#e2e8f0';
                    (e.currentTarget).style.background = '#f8fafc';
                    (e.currentTarget).style.transform = 'translateY(0)';
                    (e.currentTarget).style.boxShadow = 'none';
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: '1', flexShrink: 0 }}>{prompt.icon}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#1e293b', lineHeight: '1.3' }}>
                      {prompt.text}
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8', lineHeight: '1.4' }}>
                      {prompt.description}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isLast={i === messages.length - 1 && !isStreaming}
              onRetry={msg.role === 'assistant' ? () => {
                // Remove this response and resend the previous user message
                const prevMsgs = messages.slice(0, i);
                const lastUserMsg = [...prevMsgs].reverse().find(m => m.role === 'user');
                if (lastUserMsg) {
                  setMessages(prevMsgs);
                  setInput(lastUserMsg.content);
                  // Remove last user msg so handleSend re-adds it
                  setMessages(prevMsgs.filter(m => m.id !== lastUserMsg.id));
                  setTimeout(() => {
                    // Trigger send programmatically
                    setInput(lastUserMsg.content);
                  }, 50);
                }
              } : undefined}
              onEdit={msg.role === 'user' ? (content) => {
                // Edit: populate input with message content, remove it and everything after
                setInput(content);
                setMessages(messages.slice(0, i));
                inputRef.current?.focus();
              } : undefined}
              onDelete={() => {
                // Delete this message (and its pair if applicable)
                if (msg.role === 'user' && messages[i + 1]?.role === 'assistant') {
                  // Delete user + its response
                  setMessages(messages.filter((_, idx) => idx !== i && idx !== i + 1));
                } else if (msg.role === 'assistant' && i > 0 && messages[i - 1]?.role === 'user') {
                  // Delete response + its prompt
                  setMessages(messages.filter((_, idx) => idx !== i && idx !== i - 1));
                } else {
                  setMessages(messages.filter((_, idx) => idx !== i));
                }
              }}
              onFork={msg.role === 'assistant' ? () => {
                // Fork: keep messages up to this point, save to new tab
                const forkedMessages = messages.slice(0, i + 1);
                const forkId = `fork-${Date.now()}`;
                // Store forked messages for new tab to pick up
                try {
                  fetch('/api/v2/chat-history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      tabId: forkId,
                      messages: forkedMessages.map(m => ({
                        ...m,
                        images: undefined,
                        thinking: undefined,
                      })),
                      modelId: model.id,
                    }),
                  });
                } catch { /* ignore */ }
                // Trigger a tab creation event
                window.dispatchEvent(new CustomEvent('cortex-fork-chat', {
                  detail: { forkId, label: `Fork from "${forkedMessages[forkedMessages.length - 1]?.content.slice(0, 30)}..."` },
                }));
              } : undefined}
              onApplyToFile={handleApplyToFile}
              onOpenInCanvas={onOpenInCanvas}
              onRunInTerminal={onRunInTerminal}
            />
          ))}

          {/* Streaming response */}
          {/* Follow-up suggestions */}
          {!isStreaming && (followUps.length > 0 || followUpsLoading) && (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 12,
              animation: 'llmFadeIn 300ms ease-out',
            }}>
              {followUpsLoading ? (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  fontSize: 12,
                  color: '#94a3b8',
                }}>
                  <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
                  Thinking of follow-ups...
                </div>
              ) : followUps.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setInput(q);
                    setFollowUps([]);
                    setTimeout(() => {
                      inputRef.current?.focus();
                    }, 50);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    paddingRight: 14,
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: 20,
                    fontSize: 12,
                    color: '#475569',
                    cursor: 'pointer',
                    transition: 'all 150ms ease',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    animation: `llmFadeIn 300ms ease-out ${i * 80}ms both`,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget).style.borderColor = '#3b82f6';
                    (e.currentTarget).style.background = '#f0f9ff';
                    (e.currentTarget).style.color = '#1e40af';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget).style.borderColor = '#e2e8f0';
                    (e.currentTarget).style.background = '#f8fafc';
                    (e.currentTarget).style.color = '#475569';
                  }}
                >
                  <Sparkles size={11} style={{ opacity: 0.5 }} />
                  {q}
                </button>
              ))}
            </div>
          )}

          {isStreaming && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 4,
            }}>
              {/* Live Chain of Thought */}
              {activeThinking && activeThinking.steps.length > 0 && (
                <ChainOfThought
                  steps={activeThinking.steps}
                  thinking={activeThinking.thinking}
                  isLive
                />
              )}

              {/* Live tool call indicators (only if no chain of thought) */}
              {activeToolCalls.length > 0 && !activeThinking?.steps.length && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: '90%' }}>
                  {activeToolCalls.map((tc, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingTop: 6,
                      paddingBottom: 6,
                      paddingLeft: 10,
                      paddingRight: 10,
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: 8,
                      fontSize: 12,
                      animation: 'llmFadeIn 200ms ease-out',
                    }}>
                      <div style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: tc.status === 'done' ? '#10b981' : '#3b82f6',
                        ...(tc.status !== 'done' ? { animation: 'llmDot 1.4s ease-in-out infinite' } : {}),
                      }} />
                      <span style={{ color: '#64748b', fontWeight: 500 }}>
                        {tc.name === 'search_web' ? '🔍 Searching' :
                         tc.name === 'read_file' ? '📄 Reading' :
                         tc.name === 'list_files' ? '📁 Listing' :
                         tc.name === 'search_code' ? '🔎 Searching code' :
                         `🔧 ${tc.name}`}
                      </span>
                      <span style={{ color: '#94a3b8' }}>
                        {tc.args?.query ? `"${tc.args.query}"` :
                         tc.args?.path ? String(tc.args.path) : ''}
                      </span>
                      {tc.status === 'done' && <Check size={12} style={{ color: '#10b981' }} />}
                    </div>
                  ))}
                </div>
              )}

              {streamContent ? (
                <div style={{
                  maxWidth: '90%',
                  paddingTop: 16,
                  paddingBottom: 16,
                  fontSize: 14,
                  lineHeight: '1.6',
                  color: '#1e293b',
                  wordBreak: 'break-word',
                  animation: 'llmFadeIn 200ms ease-out',
                }}>
                  {renderLLMMarkdown(streamContent)}
                  <span style={{
                    display: 'inline-block',
                    width: 2,
                    height: 16,
                    background: '#3b82f6',
                    marginLeft: 2,
                    verticalAlign: 'text-bottom',
                    animation: 'llmDot 1s ease-in-out infinite',
                  }} />
                </div>
              ) : (
                <StreamingIndicator />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Approval Banner — blue glass */}
      {pendingApproval && (
        <div style={{
          marginLeft: 24,
          marginRight: 24,
          marginBottom: 8,
          paddingTop: 14,
          paddingBottom: 14,
          paddingLeft: 16,
          paddingRight: 16,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(99,102,241,0.06) 100%)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(59,130,246,0.2)',
          borderRadius: 12,
          animation: 'llmFadeIn 200ms ease-out',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 14 }}>
              {pendingApproval.name === 'create_github_issue' ? '📋' : '🔀'}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
              Approval Required
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#475569', marginBottom: 10, lineHeight: 1.5 }}>
            {pendingApproval.summary}
          </div>
          {/* Show details */}
          {pendingApproval.args && (
            <div style={{
              background: 'rgba(255,255,255,0.6)',
              borderRadius: 8,
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 10,
              paddingRight: 10,
              marginBottom: 10,
              fontSize: 11,
              fontFamily: 'ui-monospace, monospace',
              color: '#334155',
              maxHeight: 80,
              overflowY: 'auto',
            }}>
              {pendingApproval.name === 'create_github_issue' && (
                <>
                  <div><strong>Repo:</strong> {String(pendingApproval.args.repo)}</div>
                  <div><strong>Title:</strong> {String(pendingApproval.args.title)}</div>
                  {pendingApproval.args.labels && (
                    <div><strong>Labels:</strong> {(pendingApproval.args.labels as string[]).join(', ')}</div>
                  )}
                </>
              )}
              {pendingApproval.name === 'create_pull_request' && (
                <>
                  <div><strong>Repo:</strong> {String(pendingApproval.args.repo)}</div>
                  <div><strong>Branch:</strong> {String(pendingApproval.args.branch)}</div>
                  <div><strong>Title:</strong> {String(pendingApproval.args.title)}</div>
                  <div><strong>Base:</strong> {String(pendingApproval.args.baseBranch || 'main')}</div>
                </>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setApprovedToolsSet(prev => new Set([...prev, pendingApproval.name]));
                setPendingApproval(null);
                // Re-send the last message with approval
                const lastUserMsg = messages.filter(m => m.role === 'user').pop();
                if (lastUserMsg) {
                  setInput(lastUserMsg.content);
                  // Auto-send after state updates
                  setTimeout(() => {
                    const sendBtn = document.querySelector('[data-send-btn]') as HTMLButtonElement;
                    if (sendBtn) sendBtn.click();
                  }, 100);
                }
              }}
              style={{
                paddingTop: 7,
                paddingBottom: 7,
                paddingLeft: 16,
                paddingRight: 16,
                borderRadius: 8,
                border: 'none',
                background: '#3b82f6',
                color: 'white',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background 150ms',
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.background = '#2563eb'; }}
              onMouseLeave={(e) => { (e.currentTarget).style.background = '#3b82f6'; }}
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingApproval(null);
                // Add denial message
                setMessages(prev => [...prev, {
                  id: `deny-${Date.now()}`,
                  role: 'assistant',
                  content: `Action cancelled: ${pendingApproval.summary}`,
                  timestamp: Date.now(),
                }]);
              }}
              style={{
                paddingTop: 7,
                paddingBottom: 7,
                paddingLeft: 16,
                paddingRight: 16,
                borderRadius: 8,
                border: '1px solid #e2e8f0',
                background: 'white',
                color: '#64748b',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 150ms',
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.borderColor = '#cbd5e1'; }}
              onMouseLeave={(e) => { (e.currentTarget).style.borderColor = '#e2e8f0'; }}
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* Input area — bottom, ChatGPT style */}
      <div style={{
        paddingTop: 12,
        paddingBottom: 16,
        paddingLeft: 24,
        paddingRight: 24,
        borderTop: '1px solid #f1f5f9',
        position: 'relative',
      }}>
        {/* Attached image previews */}
        {attachedImages.length > 0 && (
          <div style={{
            display: 'flex',
            gap: 8,
            maxWidth: 720,
            marginLeft: 'auto',
            marginRight: 'auto',
            marginBottom: 8,
            overflowX: 'auto',
          }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: 'relative', flexShrink: 0 }}>
                <img
                  src={img.dataUri}
                  alt={img.name}
                  style={{
                    width: 64,
                    height: 64,
                    objectFit: 'cover',
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setAttachedImages(prev => prev.filter((_, j) => j !== i))}
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: '1px solid #e2e8f0',
                    background: 'white',
                    color: '#94a3b8',
                    fontSize: 11,
                    lineHeight: '16px',
                    textAlign: 'center',
                    cursor: 'pointer',
                    padding: 0,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Attached files pills */}
        {attachedFiles.length > 0 && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            maxWidth: 720,
            marginLeft: 'auto',
            marginRight: 'auto',
            marginBottom: 8,
          }}>
            {attachedFiles.map(f => (
              <span key={f} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                paddingTop: 3,
                paddingBottom: 3,
                paddingLeft: 8,
                paddingRight: 6,
                background: '#eff6ff',
                color: '#3b82f6',
                fontSize: 11,
                fontFamily: 'ui-monospace, monospace',
                borderRadius: 6,
                border: '1px solid #bfdbfe',
              }}>
                {f.split('/').pop()}
                <button
                  type="button"
                  onClick={() => setAttachedFiles(prev => prev.filter(p => p !== f))}
                  style={{ border: 'none', background: 'none', color: '#93c5fd', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* @file autocomplete dropdown */}
        {showFilePicker && fileSuggestions.length > 0 && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 24,
            right: 24,
            maxWidth: 720,
            marginLeft: 'auto',
            marginRight: 'auto',
            marginBottom: 4,
            background: 'white',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.1)',
            overflow: 'hidden',
            maxHeight: 200,
            overflowY: 'auto',
            zIndex: 100,
          }}>
            <div style={{
              paddingTop: 6,
              paddingBottom: 4,
              paddingLeft: 10,
              paddingRight: 10,
              fontSize: 10,
              fontWeight: 600,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Files
            </div>
            {fileSuggestions.map((f, i) => (
              <button
                key={f.path}
                type="button"
                onClick={() => handleFileSelect(f.path)}
                style={{
                  display: 'block',
                  width: '100%',
                  paddingTop: 6,
                  paddingBottom: 6,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: 'none',
                  background: i === filePickerIndex ? '#f1f5f9' : 'transparent',
                  color: '#1e293b',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, monospace',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'background 60ms',
                }}
                onMouseEnter={() => setFilePickerIndex(i)}
              >
                {f.path}
              </button>
            ))}
          </div>
        )}
        {/* Slash command picker */}
        {showSlashPicker && (
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 24,
            right: 24,
            maxWidth: 720,
            marginLeft: 'auto',
            marginRight: 'auto',
            marginBottom: 4,
            background: 'white',
            border: '1px solid #e2e8f0',
            borderRadius: 12,
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.12)',
            overflow: 'hidden',
            zIndex: 100,
            animation: 'llmFadeIn 150ms ease-out',
          }}>
            <div style={{
              paddingTop: 8,
              paddingBottom: 4,
              paddingLeft: 12,
              paddingRight: 12,
              fontSize: 10,
              fontWeight: 600,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}>
              Commands
            </div>
            {SLASH_COMMANDS
              .filter(c => c.command.startsWith(input.toLowerCase()))
              .map((cmd, i) => (
                <button
                  key={cmd.command}
                  type="button"
                  onClick={() => {
                    setInput(cmd.prefix);
                    setShowSlashPicker(false);
                    inputRef.current?.focus();
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 12,
                    paddingRight: 12,
                    border: 'none',
                    background: i === slashIndex ? '#f1f5f9' : 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 60ms',
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span style={{ fontSize: 16 }}>{cmd.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#1e293b' }}>
                      {cmd.command} <span style={{ fontWeight: 400, color: '#64748b' }}>{cmd.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{cmd.description}</div>
                  </div>
                </button>
              ))}
          </div>
        )}

        {/* Unified input container — textarea + toolbar in one box */}
        <div
          style={{
            maxWidth: 720,
            marginLeft: 'auto',
            marginRight: 'auto',
            border: '1px solid #e2e8f0',
            borderRadius: 18,
            background: '#fafafa',
            transition: 'border-color 200ms, box-shadow 200ms',
            overflow: 'hidden',
          }}
          onFocus={(e) => {
            (e.currentTarget).style.borderColor = '#3b82f6';
            (e.currentTarget).style.boxShadow = '0 0 0 3px rgba(59, 130, 246, 0.1)';
          }}
          onBlur={(e) => {
            (e.currentTarget).style.borderColor = '#e2e8f0';
            (e.currentTarget).style.boxShadow = 'none';
          }}
        >
          {/* Textarea area — upper portion */}
          <div style={{
            paddingTop: 14,
            paddingBottom: 8,
            paddingLeft: 18,
            paddingRight: 18,
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              placeholder={`Message ${model.label}...`}
              rows={1}
              style={{
                width: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: '#1e293b',
                fontSize: 14,
                fontFamily: '-apple-system, system-ui, sans-serif',
                lineHeight: '1.5',
                resize: 'none',
                minHeight: 24,
                maxHeight: 200,
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Bottom toolbar — icons left, model picker + send right */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 4,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 10,
          }}>
            {/* Left icons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {/* Attach file */}
              <label
                title="Attach file or image"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  transition: 'color 150ms, background 150ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.color = '#64748b'; (e.currentTarget).style.background = '#f1f5f9'; }}
                onMouseLeave={(e) => { (e.currentTarget).style.color = '#94a3b8'; (e.currentTarget).style.background = 'transparent'; }}
              >
                <Plus size={16} />
                <input
                  type="file"
                  accept="image/*,.txt,.md,.ts,.tsx,.js,.jsx,.py,.json,.yaml,.yml,.toml,.css,.html"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const files = e.target.files;
                    if (!files) return;
                    for (const file of files) {
                      if (file.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = () => {
                          setAttachedImages(prev => [...prev.slice(0, 3), { dataUri: reader.result as string, name: file.name, mimeType: file.type }]);
                        };
                        reader.readAsDataURL(file);
                      } else {
                        setAttachedFiles(prev => [...new Set([...prev, file.name])]);
                      }
                    }
                    e.target.value = '';
                  }}
                />
              </label>

              {/* Keyboard shortcuts hint */}
              <span style={{
                fontSize: 10,
                color: '#cbd5e1',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                @file · /cmds
              </span>
            </div>

            {/* Right — model picker + send */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ModelPicker
                selected={model}
                onSelect={setModel}
                disabled={isStreaming}
              />

              {isStreaming ? (
                <button
                  type="button"
                  onClick={handleStop}
                  title="Stop generating (Esc)"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: '#ef4444',
                    color: 'white',
                    cursor: 'pointer',
                    flexShrink: 0,
                    transition: 'background 150ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget).style.background = '#dc2626'; }}
                  onMouseLeave={(e) => { (e.currentTarget).style.background = '#ef4444'; }}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  data-send-btn="true"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  title="Send message (Enter)"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: input.trim() ? '#1e293b' : '#e2e8f0',
                    color: input.trim() ? 'white' : '#94a3b8',
                    cursor: input.trim() ? 'pointer' : 'default',
                    flexShrink: 0,
                    transition: 'all 150ms',
                  }}
                  onMouseEnter={(e) => { if (input.trim()) (e.currentTarget).style.background = '#0f172a'; }}
                  onMouseLeave={(e) => { if (input.trim()) (e.currentTarget).style.background = '#1e293b'; }}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Apply to File Modal */}
      {applyModal && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.3)',
          backdropFilter: 'blur(2px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          animation: 'llmFadeIn 150ms ease-out',
        }} onClick={() => setApplyModal(null)}>
          <div
            style={{
              background: 'white',
              borderRadius: 16,
              boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
              width: 420,
              maxWidth: '90%',
              overflow: 'hidden',
              animation: 'llmFadeIn 200ms ease-out',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              paddingTop: 16,
              paddingBottom: 12,
              paddingLeft: 20,
              paddingRight: 20,
              borderBottom: '1px solid #f1f5f9',
            }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a' }}>
                Apply to File
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                {applyModal.language} · {applyModal.code.split('\n').length} lines
              </div>
            </div>

            {/* File search input */}
            <div style={{ paddingTop: 16, paddingBottom: 16, paddingLeft: 20, paddingRight: 20, position: 'relative' }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: '#64748b', display: 'block', marginBottom: 6 }}>
                Search for a file or type a new path
              </label>
              <input
                type="text"
                value={applyPath}
                onChange={(e) => {
                  setApplyPath(e.target.value);
                  searchApplyFiles(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (applyFileSuggestions.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setApplyFileIndex(prev => Math.min(prev + 1, applyFileSuggestions.length - 1));
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setApplyFileIndex(prev => Math.max(prev - 1, 0));
                      return;
                    }
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      setApplyPath(applyFileSuggestions[applyFileIndex].path);
                      setApplyFileSuggestions([]);
                      return;
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      setApplyPath(applyFileSuggestions[applyFileIndex].path);
                      setApplyFileSuggestions([]);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && applyFileSuggestions.length === 0) {
                    e.preventDefault();
                    doApply();
                  }
                }}
                placeholder="Start typing to search files..."
                autoFocus
                style={{
                  width: '100%',
                  paddingTop: 10,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  fontSize: 13,
                  fontFamily: 'ui-monospace, monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 150ms',
                }}
                onFocus={(e) => { (e.currentTarget).style.borderColor = '#3b82f6'; }}
                onBlur={(e) => {
                  // Delay blur so click on suggestion registers
                  setTimeout(() => {
                    (e.currentTarget).style.borderColor = '#e2e8f0';
                    setApplyFileSuggestions([]);
                  }, 200);
                }}
              />

              {/* File search results dropdown */}
              {applyFileSuggestions.length > 0 && (
                <div style={{
                  position: 'absolute',
                  left: 20,
                  right: 20,
                  top: '100%',
                  marginTop: -12,
                  background: 'white',
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
                  maxHeight: 200,
                  overflowY: 'auto',
                  zIndex: 10,
                }}>
                  {applyFileSuggestions.map((f, idx) => (
                    <button
                      key={f.path}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setApplyPath(f.path);
                        setApplyFileSuggestions([]);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        paddingTop: 8,
                        paddingBottom: 8,
                        paddingLeft: 12,
                        paddingRight: 12,
                        border: 'none',
                        background: idx === applyFileIndex ? '#f1f5f9' : 'transparent',
                        color: '#1e293b',
                        fontSize: 12,
                        fontFamily: 'ui-monospace, monospace',
                        textAlign: 'left',
                        cursor: 'pointer',
                        transition: 'background 60ms',
                      }}
                      onMouseEnter={() => setApplyFileIndex(idx)}
                    >
                      {f.path}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                {applyPath.trim() ? `Will write to: ${applyPath}` : 'Type to search existing files or enter a new path'}
              </div>
            </div>

            {/* Actions */}
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              paddingTop: 12,
              paddingBottom: 16,
              paddingLeft: 20,
              paddingRight: 20,
              borderTop: '1px solid #f1f5f9',
            }}>
              <button
                type="button"
                onClick={() => setApplyModal(null)}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 16,
                  paddingRight: 16,
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  background: 'white',
                  color: '#64748b',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={doApply}
                disabled={!applyPath.trim() || applyStatus === 'applying'}
                style={{
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 16,
                  paddingRight: 16,
                  border: 'none',
                  borderRadius: 8,
                  background: applyStatus === 'done' ? '#10b981' : applyStatus === 'error' ? '#ef4444' : '#3b82f6',
                  color: 'white',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: applyPath.trim() ? 'pointer' : 'not-allowed',
                  opacity: applyPath.trim() ? 1 : 0.5,
                  transition: 'background 150ms',
                }}
              >
                {applyStatus === 'applying' ? 'Applying...' :
                 applyStatus === 'done' ? '✓ Applied' :
                 applyStatus === 'error' ? 'Error — Try Again' :
                 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
