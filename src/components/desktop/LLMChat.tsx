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
} from 'lucide-react';
import { renderLLMMarkdown } from './LLMMarkdown';
import { saveChatHistory, loadChatHistory } from '@/lib/llm/chat-history';

// ── Types ──

export interface LLMMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  timestamp: number;
  images?: string[]; // data URIs for display
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 8,
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          background: 'white',
          color: '#1e293b',
          fontSize: 13,
          fontWeight: 500,
          fontFamily: '-apple-system, system-ui, sans-serif',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'border-color 150ms, box-shadow 150ms',
        }}
        onMouseEnter={(e) => { if (!disabled) (e.currentTarget).style.borderColor = '#94a3b8'; }}
        onMouseLeave={(e) => { (e.currentTarget).style.borderColor = '#e2e8f0'; }}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: selected.color,
          flexShrink: 0,
        }} />
        {selected.label}
        <ChevronDown size={12} style={{ color: '#94a3b8', marginLeft: 2 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          zIndex: 9000,
          minWidth: 240,
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.12)',
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
        </div>
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

function MessageBubble({ message, isLast, onRetry, onEdit }: MessageBubbleProps) {
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
        background: isUser ? '#3b82f6' : 'transparent',
        color: isUser ? 'white' : '#1e293b',
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
        ) : renderLLMMarkdown(message.content)}
      </div>

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
        </div>
      )}
    </div>
  );
}

/** Streaming dots indicator */
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

export default function LLMChat({ tabId }: { tabId: string }) {
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
      const res = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.id,
          provider: model.provider,
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: messageForModel },
          ],
        }),
        signal: controller.signal,
      });

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
              if (parsed.type === 'content') {
                fullContent += parsed.text;
                setStreamContent(fullContent);
              } else if (parsed.type === 'usage') {
                tokens = { input: parsed.inputTokens, output: parsed.outputTokens };
                costUsd = parsed.costUsd;
              } else if (parsed.type === 'error') {
                throw new Error(parsed.message);
              }
            } catch (e) {
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
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setStreamContent('');
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

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showFilePicker, fileSuggestions, filePickerIndex, handleFileSelect]);

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#ffffff',
      fontFamily: '-apple-system, system-ui, sans-serif',
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
        <ModelPicker
          selected={model}
          onSelect={setModel}
          disabled={isStreaming}
        />
        <div style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => { setMessages([]); setStreamContent(''); }}
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
        {/* Empty state — centered, Claude Desktop style */}
        {isEmpty && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 12,
            opacity: 0.7,
          }}>
            <Sparkles size={32} style={{ color: '#cbd5e1' }} />
            <div style={{
              fontSize: 18,
              fontWeight: 500,
              color: '#94a3b8',
            }}>
              Start a conversation
            </div>
            <div style={{
              fontSize: 13,
              color: '#cbd5e1',
              textAlign: 'center',
              maxWidth: 320,
              lineHeight: '1.5',
            }}>
              Chat directly with {model.label}. Your messages go straight to the model — no agent runtime needed.
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
            />
          ))}

          {/* Streaming response */}
          {isStreaming && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 4,
            }}>
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
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          maxWidth: 720,
          marginLeft: 'auto',
          marginRight: 'auto',
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 16,
          paddingRight: 10,
          border: '1px solid #e2e8f0',
          borderRadius: 16,
          background: '#fafafa',
          transition: 'border-color 200ms, box-shadow 200ms',
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
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder={`Message ${model.label}... (@ files, paste images)`}
            rows={1}
            style={{
              flex: 1,
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
            }}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStop}
              title="Stop generating"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                border: 'none',
                borderRadius: 8,
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
              onClick={handleSend}
              disabled={!input.trim()}
              title="Send message"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                border: 'none',
                borderRadius: 8,
                background: input.trim() ? '#3b82f6' : '#e2e8f0',
                color: input.trim() ? 'white' : '#94a3b8',
                cursor: input.trim() ? 'pointer' : 'default',
                flexShrink: 0,
                transition: 'background 150ms',
              }}
              onMouseEnter={(e) => { if (input.trim()) (e.currentTarget).style.background = '#2563eb'; }}
              onMouseLeave={(e) => { if (input.trim()) (e.currentTarget).style.background = '#3b82f6'; }}
            >
              <Send size={14} />
            </button>
          )}
        </div>
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          paddingTop: 6,
          fontSize: 11,
          color: '#cbd5e1',
        }}>
          {model.label} · @file to attach · Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}
