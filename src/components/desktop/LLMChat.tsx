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
} from 'lucide-react';

// ── Types ──

export interface LLMMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  timestamp: number;
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
function MessageBubble({ message, isLast }: { message: LLMMessage; isLast: boolean }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [message.content]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      gap: 4,
      animation: isLast ? 'llmFadeIn 200ms ease-out' : undefined,
    }}>
      {/* Message content */}
      <div style={{
        maxWidth: '85%',
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
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.content}
      </div>

      {/* Meta bar — model, tokens, actions */}
      {!isUser && message.content && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 2,
          paddingBottom: 4,
        }}>
          {message.model && (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{message.model}</span>
          )}
          {message.tokens && (
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>
              {message.tokens.input + message.tokens.output} tokens
            </span>
          )}
          {message.costUsd != null && message.costUsd > 0 && (
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>
              ${message.costUsd.toFixed(4)}
            </span>
          )}
          <button
            type="button"
            onClick={handleCopy}
            title="Copy"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              border: 'none',
              background: 'transparent',
              color: copied ? '#10b981' : '#cbd5e1',
              cursor: 'pointer',
              borderRadius: 4,
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => { if (!copied) (e.currentTarget).style.color = '#64748b'; }}
            onMouseLeave={(e) => { if (!copied) (e.currentTarget).style.color = '#cbd5e1'; }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-select model based on configured API keys
  useEffect(() => {
    if (modelResolved) return;
    (async () => {
      try {
        const res = await fetch('/api/v2/keys');
        if (!res.ok) return;
        const data = await res.json();
        const configured = new Set(
          (data.providers ?? [])
            .filter((p: { configured: boolean }) => p.configured)
            .map((p: { id: string }) => p.id)
        );
        // Pick first model whose provider has a key
        const match = MODELS.find(m => configured.has(m.provider));
        if (match) setModel(match);
      } catch { /* ignore */ }
      setModelResolved(true);
    })();
  }, [modelResolved]);

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

  // Auto-resize textarea
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 200) + 'px';
    }
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Add user message
    const userMsg: LLMMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';

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
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

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
                  maxWidth: '85%',
                  paddingTop: 16,
                  paddingBottom: 16,
                  fontSize: 14,
                  lineHeight: '1.6',
                  color: '#1e293b',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  animation: 'llmFadeIn 200ms ease-out',
                }}>
                  {streamContent}
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
      }}>
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
            placeholder={`Message ${model.label}...`}
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
          {model.label} · Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}
