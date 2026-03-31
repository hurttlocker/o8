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
  AlertCircle,
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
  Loader2,
  Brain,
  ChevronRight,
  Search,
  FileText,
  Zap,
  Eye,
  Trash2,
  GitBranch,
  History,
  Star,
  PanelLeftClose,
  MessageSquare,
  X,
  ArrowUp,
  ArrowDown,
  Plus,
} from 'lucide-react';
import { renderLLMMarkdown } from './LLMMarkdown';
import { saveChatHistory, loadChatHistory, type SavedChatRepoContext } from '@/lib/llm/chat-history';
import { CompactionNode } from './CompactionNode';
import { shouldCompact, compactConversation, type LLMMessage as CompactMessage } from '@/lib/chat/compaction';
import { IssueLinkPickerModal, buildLinkedIssueContext, type LinkedIssueRef } from './IssueLinkPicker';

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
  recalledFacts?: number; // Cortex memory facts recalled for this message
  isCompaction?: boolean; // compaction node — compressed older messages
  compactedCount?: number; // how many messages were compressed
  isPartial?: boolean; // restored in-flight assistant output after reload
  fallbackNotice?: string; // model fallback notice (e.g. "Gemini 3.1 Pro unavailable — using Gemini 2.5 Pro")
}

interface FileChangePreview {
  id: string;
  path: string;
  shortFile: string;
  tool: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'apply_patch';
  additions: number;
  deletions: number;
  oldText?: string;
  newText?: string;
  content?: string;
}

interface QueuedContextCard {
  id: string;
  reason?: string;
  text: string;
  title: string;
  meta: string[];
  preview?: string;
}

function buildQueuedContextCard(injection: { id: string; text: string; reason?: string }): QueuedContextCard {
  const lines = injection.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0]?.match(/^\[(.+)\]$/)?.[1] ?? lines[0] ?? 'Context';
  const meta = lines
    .slice(1)
    .filter((line) => /^[A-Za-z][A-Za-z ]+:\s+/.test(line))
    .slice(0, 3);
  const firstBodyLine = lines.find((line) => !/^\[.+\]$/.test(line) && !/^[A-Za-z][A-Za-z ]+:\s+/.test(line));
  const preview = firstBodyLine && firstBodyLine !== header ? firstBodyLine : undefined;

  const title = injection.reason?.startsWith('pr-comment')
    ? (meta[0]?.startsWith('Author:') ? meta[0].replace(/^Author:\s*/, '') : 'PR comment')
    : injection.reason?.startsWith('ci-check')
      ? 'CI context'
      : injection.reason?.startsWith('deploy')
        ? 'Deploy context'
        : header;

  return {
    id: injection.id,
    reason: injection.reason,
    text: injection.text,
    title,
    meta,
    preview,
  };
}

function buildConversationSummary(messages: LLMMessage[]) {
  const latestUser = [...messages].reverse().find((message) => (
    message.role === 'user'
    && message.content.trim()
    && !/^(hi|hey|hello)\b/i.test(message.content.trim())
  ));
  if (!latestUser) return null;
  const summary = latestUser.content.replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.length <= 48 ? summary : `${summary.slice(0, 47)}…`;
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

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const HISTORY_DELETED_EVENT = 'cortex-llm-history-deleted';

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
          background: open ? THEME_ACCENT_SOFT : 'transparent',
          color: open ? 'var(--t-text)' : 'var(--t-text-secondary)',
          fontSize: 13,
          fontWeight: 400,
          fontFamily: '-apple-system, system-ui, sans-serif',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'color 150ms, background 150ms',
        }}
        onMouseEnter={(e) => { if (!disabled && !open) { (e.currentTarget).style.color = 'var(--t-text)'; (e.currentTarget).style.background = THEME_ACCENT_SOFT; } }}
        onMouseLeave={(e) => { if (!open) { (e.currentTarget).style.color = 'var(--t-text-secondary)'; (e.currentTarget).style.background = 'transparent'; } }}
      >
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: selected.color,
          flexShrink: 0,
        }} />
        {selected.label}
        <ChevronDown size={12} style={{ color: 'var(--t-text-muted)', marginLeft: 2, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </button>

      {open && createPortal(
        <div ref={dropRef} style={{
          position: 'fixed',
          bottom: dropPos.bottom,
          right: dropPos.right,
          zIndex: 9999,
          minWidth: 260,
          background: THEME_PANEL_GLASS,
          border: '1px solid var(--t-panel-border)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: 'var(--t-panel-shadow)',
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
                background: m.id === selected.id ? THEME_ACCENT_SOFT : 'transparent',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: '-apple-system, system-ui, sans-serif',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 100ms',
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT; }}
              onMouseLeave={(e) => { (e.currentTarget).style.background = m.id === selected.id ? THEME_ACCENT_SOFT : 'transparent'; }}
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
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{m.description}</div>
              </div>
              {m.id === selected.id && <Check size={14} style={{ color: THEME_ACCENT }} />}
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
  border: '1px solid var(--t-panel-border)',
  background: THEME_BG_CARD,
  color: 'var(--t-text-secondary)',
  cursor: 'pointer',
  borderRadius: 8,
  transition: 'color 150ms, background 150ms, border-color 150ms',
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
          (e.currentTarget).style.color = 'var(--t-text-secondary)';
          (e.currentTarget).style.background = THEME_ACCENT_SOFT;
          (e.currentTarget).style.borderColor = THEME_ACCENT_BORDER;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget).style.color = 'var(--t-text-faint)';
          (e.currentTarget).style.background = THEME_BG_CARD;
          (e.currentTarget).style.borderColor = 'var(--t-panel-border)';
        }
      }}
    >
      {icon}
    </button>
  );
}

function lineCount(text?: string) {
  if (!text) return 0;
  return text.split('\n').length;
}

function basenameFromPath(filePath?: string) {
  if (!filePath) return 'file';
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function deriveFileChangesFromPatch(patchText: string) {
  const changes: FileChangePreview[] = [];
  const fileBlocks = patchText.split(/\*\*\*\s+(Update|Add)\s+File:\s+/);

  for (let i = 1; i < fileBlocks.length; i += 2) {
    const operation = fileBlocks[i];
    const block = fileBlocks[i + 1];
    if (!block) continue;
    const lines = block.split('\n');
    const filePath = lines[0].trim();
    const shortFile = basenameFromPath(filePath);

    if (operation === 'Add') {
      const content = lines.slice(1).filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
      changes.push({
        id: `patch-${shortFile}-${changes.length}`,
        path: filePath,
        shortFile,
        tool: 'apply_patch',
        additions: lineCount(content),
        deletions: 0,
        content,
      });
      continue;
    }

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let additions = 0;
    let deletions = 0;

    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) continue;
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
        deletions += 1;
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
        additions += 1;
      } else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      }
    }

    changes.push({
      id: `patch-${shortFile}-${changes.length}`,
      path: filePath,
      shortFile,
      tool: 'apply_patch',
      additions,
      deletions,
      oldText: oldLines.join('\n'),
      newText: newLines.join('\n'),
    });
  }

  return changes;
}

function deriveFileChangesFromTools(toolCalls?: ToolCallInfo[]): FileChangePreview[] {
  if (!toolCalls?.length) return [];
  const changes: FileChangePreview[] = [];

  for (const tool of toolCalls) {
    const name = tool.name;
    const args = tool.args ?? {};

    if (name === 'apply_patch') {
      const patch = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
      if (patch) {
        changes.push(...deriveFileChangesFromPatch(patch));
      }
      continue;
    }

    if (name === 'Edit' || name === 'edit_file') {
      const filePath = String(args.file_path ?? args.path ?? '');
      if (!filePath) continue;
      const oldText = typeof args.old_string === 'string' ? args.old_string : typeof args.oldText === 'string' ? args.oldText : undefined;
      const newText = typeof args.new_string === 'string' ? args.new_string : typeof args.newText === 'string' ? args.newText : undefined;
      changes.push({
        id: `${filePath}-${changes.length}`,
        path: filePath,
        shortFile: basenameFromPath(filePath),
        tool: 'Edit',
        additions: lineCount(newText),
        deletions: lineCount(oldText),
        oldText,
        newText,
      });
      continue;
    }

    if (name === 'Write' || name === 'write_file' || name === 'NotebookEdit') {
      const filePath = String(args.file_path ?? args.path ?? '');
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) continue;
      changes.push({
        id: `${filePath}-${changes.length}`,
        path: filePath,
        shortFile: basenameFromPath(filePath),
        tool: name === 'NotebookEdit' ? 'NotebookEdit' : 'Write',
        additions: lineCount(content),
        deletions: 0,
        content,
      });
      continue;
    }

    if (name === 'MultiEdit') {
      const filePath = String(args.file_path ?? args.path ?? '');
      const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : [];
      if (!filePath || edits.length === 0) continue;
      edits.forEach((edit, index) => {
        const oldText = typeof edit.old_string === 'string' ? edit.old_string : undefined;
        const newText = typeof edit.new_string === 'string' ? edit.new_string : undefined;
        changes.push({
          id: `${filePath}-${index}-${changes.length}`,
          path: filePath,
          shortFile: basenameFromPath(filePath),
          tool: 'MultiEdit',
          additions: lineCount(newText),
          deletions: lineCount(oldText),
          oldText,
          newText,
        });
      });
    }
  }

  return changes;
}

function FileChangeCard({ change }: { change: FileChangePreview }) {
  const [expanded, setExpanded] = useState(false);
  const isWrite = Boolean(change.content && !change.oldText && !change.newText);
  return (
    <div style={{ width: '100%' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '10px 12px',
          background: THEME_BG_CARD,
          border: '1px solid var(--t-panel-border)',
          borderRadius: 12,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <ChevronRight
          size={14}
          style={{
            color: 'var(--t-text-secondary)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 160ms ease',
            flexShrink: 0,
          }}
        />
        <FileText size={14} style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
            1 file changed
          </div>
          <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {change.shortFile}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}>+{change.additions}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626' }}>-{change.deletions}</span>
        </div>
      </button>
      {expanded ? (
        <div style={{
          marginTop: 8,
          border: '1px solid var(--t-panel-border)',
          borderRadius: 12,
          overflow: 'hidden',
          background: THEME_PANEL_GLASS,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid var(--t-divider)',
            background: THEME_BG_CARD,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{change.path}</div>
            <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', fontWeight: 700 }}>{change.tool}</div>
          </div>
          <div style={{ padding: 12 }}>
            {isWrite ? (
              <pre style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                color: 'var(--t-text)',
              }}>
                {change.content}
              </pre>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>Before</div>
                  <pre style={{
                    margin: 0,
                    padding: 10,
                    borderRadius: 10,
                    background: 'rgba(127, 29, 29, 0.18)',
                    color: '#7f1d1d',
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    minHeight: 80,
                  }}>
                    {change.oldText || 'No previous content'}
                  </pre>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', marginBottom: 6 }}>After</div>
                  <pre style={{
                    margin: 0,
                    padding: 10,
                    borderRadius: 10,
                    background: 'rgba(20, 83, 45, 0.22)',
                    color: '#14532d',
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    minHeight: 80,
                  }}>
                    {change.newText || 'No updated content'}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function MessageBubble({ message, isLast, onRetry, onEdit, onDelete, onFork, onApplyToFile, onOpenInCanvas, onRunInTerminal }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState<'up' | 'down' | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [ttsState, setTtsState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ttsProgress, setTtsProgress] = useState(0);
  const isUser = message.role === 'user';
  const fileChanges = !isUser ? deriveFileChangesFromTools(message.toolCalls) : [];
  const visibleToolCalls = !isUser
    ? (message.toolCalls ?? []).filter((tool) => !['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit_file', 'write_file', 'apply_patch'].includes(tool.name))
    : [];

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
        background: isUser ? 'transparent' : message.isError ? 'rgba(239,68,68,0.12)' : 'transparent',
        color: isUser ? 'var(--t-text-muted)' : message.isError ? '#dc2626' : 'var(--t-text)',
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
      {/* Fallback model notice — shown above assistant content */}
      {!isUser && message.fallbackNotice && (
        <div style={{
          maxWidth: '90%',
          paddingTop: 2,
          paddingBottom: 6,
          paddingLeft: 2,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          fontStyle: 'italic',
          fontFamily: '-apple-system, system-ui, sans-serif',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}>
          <svg width="12" height="12" viewBox="0 0 256 256" fill="none" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M236.8 188.09 149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19 23.51 23.51 0 0 0 .02-23.72ZM120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z" fill="currentColor"/>
          </svg>
          {message.fallbackNotice}
        </div>
      )}
      {!isUser && message.isPartial ? (
        <div style={{
          maxWidth: '90%',
          paddingLeft: 2,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          fontStyle: 'italic',
        }}>
          Recovered after reload
        </div>
      ) : null}

      {/* Chain of Thought — shows above message content for completed messages */}
      {!isUser && (message.thinkingSteps || message.thinking) && (
        <ChainOfThought
          steps={message.thinkingSteps || []}
          thinking={message.thinking}
          durationMs={message.thinkingDurationMs}
        />
      )}

      {!isUser && fileChanges.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          width: '100%',
          maxWidth: '90%',
          marginTop: 4,
        }}>
          {fileChanges.map((change) => (
            <FileChangeCard key={change.id} change={change} />
          ))}
        </div>
      )}

      {/* Tool calls display */}
      {!isUser && visibleToolCalls.length > 0 && !(message.thinkingSteps && message.thinkingSteps.length > 0) && (
        <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxWidth: '90%',
              marginTop: 4,
            }}>
          {visibleToolCalls.map((tc, i) => (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 10,
              paddingRight: 10,
              background: THEME_BG_CARD,
              border: '1px solid var(--t-panel-border)',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: '-apple-system, system-ui, sans-serif',
              animation: 'llmFadeIn 200ms ease-out',
            }}>
              <div style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: tc.status === 'done' ? '#10b981' : '#3b82f6',
                flexShrink: 0,
                ...(tc.status !== 'done' ? { animation: 'llmDot 1.4s ease-in-out infinite' } : {}),
              }} />
              <span style={{ color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                {tc.name === 'search_web' ? '🔍 Searched' :
                 tc.name === 'read_file' ? '📄 Read' :
                 tc.name === 'list_files' ? '📁 Listed' :
                 tc.name === 'search_code' ? '🔎 Searched code' :
                 `🔧 ${tc.name}`}
              </span>
              <span style={{ color: 'var(--t-text-muted)' }}>
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
                background: THEME_ACCENT_SOFT,
                border: `1px solid ${THEME_ACCENT_BORDER}`,
                borderRadius: 6,
                fontSize: 11,
                color: THEME_ACCENT,
                textDecoration: 'none',
                fontFamily: '-apple-system, system-ui, sans-serif',
                transition: 'background 100ms',
                cursor: 'pointer',
                animation: 'llmFadeIn 200ms ease-out',
              }}
              onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT_STRONG; }}
              onMouseLeave={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT; }}
            >
              {src.index && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: THEME_ACCENT,
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
              color: 'var(--t-text-muted)',
              marginRight: 4,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>
              {message.model}
            </span>
          )}
          {message.tokens && (
            <span style={{
              fontSize: 10,
              color: 'var(--t-text-faint)',
              marginRight: 4,
              fontFamily: 'ui-monospace, monospace',
            }}>
              {message.tokens.input + message.tokens.output} tok
            </span>
          )}
          {message.costUsd != null && message.costUsd > 0 && (
            <span style={{
              fontSize: 10,
              color: 'var(--t-text-faint)',
              marginRight: 6,
              fontFamily: 'ui-monospace, monospace',
            }}>
              ${message.costUsd.toFixed(4)}
            </span>
          )}
          {/* Memory indicator */}
          {message.recalledFacts != null && message.recalledFacts > 0 && (
            <span
              title={`${message.recalledFacts} memor${message.recalledFacts === 1 ? 'y' : 'ies'} recalled from Cortex`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                fontSize: 10,
                color: '#8b5cf6',
                marginRight: 4,
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              <Brain size={10} />
              {message.recalledFacts}
            </span>
          )}

          {/* Divider */}
          <div style={{ width: 1, height: 14, background: 'var(--t-divider)', marginLeft: 2, marginRight: 2 }} />

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

export function ChainOfThought({
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
      marginBottom: 6,
      animation: 'llmFadeIn 200ms ease-out',
    }}>
      {/* Header — click to expand */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 10,
          background: isLive ? THEME_ACCENT_SOFT : THEME_BG_CARD,
          border: `1px solid ${isLive ? THEME_ACCENT_BORDER : 'var(--t-panel-border)'}`,
          borderRadius: 9,
          cursor: 'pointer',
          width: 'auto',
          minWidth: 0,
          textAlign: 'left',
          transition: 'all 150ms ease',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget).style.background = THEME_ACCENT_SOFT;
          (e.currentTarget).style.borderColor = THEME_ACCENT_BORDER;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget).style.background = isLive ? THEME_ACCENT_SOFT : THEME_BG_CARD;
          (e.currentTarget).style.borderColor = isLive ? THEME_ACCENT_BORDER : 'var(--t-panel-border)';
        }}
      >
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          flexShrink: 0,
          color: isLive ? THEME_ACCENT : 'var(--t-text-muted)',
          ...(isLive ? { animation: 'llmDot 1.4s ease-in-out infinite' } : {}),
        }}>
          <Brain size={11} />
        </span>

        {/* Label */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 500,
            fontStyle: 'italic',
            color: 'var(--t-text-secondary)',
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
        </div>

        {/* Chevron */}
        <ChevronRight
          size={12}
          style={{
            color: 'var(--t-text-muted)',
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
          borderLeft: '2px solid var(--t-divider)',
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
  { command: '/run', label: 'Run command', description: 'Execute a terminal command in the workspace', icon: '⚡', prefix: 'Run this terminal command: ' },
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

function PromptIcon({ d, size = 18, color = 'currentColor' }: { d: string; size?: number; color?: string }) {
  return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} fill={color} viewBox="0 0 256 256" style={{ display: 'block', flexShrink: 0 }}><path d={d} /></svg>);
}

const PROMPT_ICONS = {
  tree: 'M160,112h48a16,16,0,0,0,16-16V48a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16V64H128a24,24,0,0,0-24,24v32H72v-8A16,16,0,0,0,56,96H24A16,16,0,0,0,8,112v32a16,16,0,0,0,16,16H56a16,16,0,0,0,16-16v-8h32v32a24,24,0,0,0,24,24h16v16a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V160a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16v16H128a8,8,0,0,1-8-8V88a8,8,0,0,1,8-8h16V96A16,16,0,0,0,160,112ZM56,144H24V112H56v32Zm104,16h48v48H160Zm0-112h48V96H160Z',
  search: 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  file: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
  diff: 'M112,152a8,8,0,0,0-8,8v28.69L66.34,151A8,8,0,0,1,64,145.37V95a32,32,0,1,0-16,0v50.38a23.85,23.85,0,0,0,7,17L92.69,200H64a8,8,0,0,0,0,16h48a8,8,0,0,0,8-8V160A8,8,0,0,0,112,152ZM40,64A16,16,0,1,1,56,80,16,16,0,0,1,40,64Zm168,97V110.63a23.85,23.85,0,0,0-7-17L163.31,56H192a8,8,0,0,0,0-16H144a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31L189.66,105a8,8,0,0,1,2.34,5.66V161a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,200,208Z',
  rocket: 'M152,224a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,224ZM128,112a12,12,0,1,0-12-12A12,12,0,0,0,128,112Zm95.62,43.83-12.36,55.63a16,16,0,0,1-25.51,9.11L158.51,200h-61L70.25,220.57a16,16,0,0,1-25.51-9.11L32.38,155.83a16.09,16.09,0,0,1,3.32-13.71l28.56-34.26a123.07,123.07,0,0,1,8.57-36.67c12.9-32.34,36-52.63,45.37-59.85a16,16,0,0,1,19.6,0c9.34,7.22,32.47,27.51,45.37,59.85a123.07,123.07,0,0,1,8.57,36.67l28.56,34.26A16.09,16.09,0,0,1,223.62,155.83ZM99.43,184h57.14c21.12-37.54,25.07-73.48,11.74-106.88C156.55,47.64,134.49,29,128,24c-6.51,5-28.57,23.64-40.33,53.12C74.36,110.52,78.31,146.46,99.43,184Zm-15,5.85Q68.28,160.5,64.83,132.16L48,152.36,60.36,208l.18-.13ZM208,152.36l-16.83-20.2q-3.42,28.28-19.56,57.69l23.85,18,.18.13Z',
} as const;

const SUGGESTED_PROMPTS = [
  { iconKey: 'tree' as const, text: 'Explain this codebase architecture', description: 'High-level structure and key patterns' },
  { iconKey: 'search' as const, text: 'Find all TODO comments in the code', description: 'Surface technical debt and pending work' },
  { iconKey: 'file' as const, text: 'Write a README for this project', description: 'Generate documentation from source' },
  { iconKey: 'diff' as const, text: 'Review the most recent changes', description: 'Analyze recent commits for issues' },
  { iconKey: 'search' as const, text: 'Suggest tests for the auth module', description: 'Generate test cases for critical paths' },
  { iconKey: 'rocket' as const, text: 'What could be optimized here?', description: 'Identify performance improvements' },
];

function buildRepoRequestHeaders(preferredRepo?: {
  name?: string;
  localPath?: string;
  branch?: string | null;
  remoteUrl?: string | null;
} | null): Record<string, string> {
  const repoPath = preferredRepo?.localPath?.trim();
  if (!repoPath) {
    return {};
  }
  return {
    'x-cortex-repo-path': repoPath,
  };
}

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

export default function LLMChat({ tabId, preferredRepo, linkedIssue, draftInjection, onSummaryChange, onConsumeDraftInjection, onLinkedIssueChange, onOpenInCanvas, onRunInTerminal, onOpenHistoryChat }: {
  tabId: string;
  preferredRepo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null;
  linkedIssue?: LinkedIssueRef | null;
  draftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string } | null;
  onSummaryChange?: (tabId: string, summary: string | null) => void;
  onConsumeDraftInjection?: (injectionId: string) => void;
  onLinkedIssueChange?: (issue: LinkedIssueRef | null) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
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
    id?: string;
    name: string;
    args: Record<string, unknown>;
    summary: string;
    editable?: boolean;
    diff?: { before?: string; after?: string; path?: string };
  } | null>(null);
  const [editedCommand, setEditedCommand] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [showTypingIndicator, setShowTypingIndicator] = useState(false);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<{
    tabId: string; title: string; preview: string; messageCount: number;
    model: string; savedAt: string; modifiedAt: string; starred: boolean;
    repoName?: string | null; repoPath?: string | null; repoBranch?: string | null; remoteUrl?: string | null;
  }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [applyModal, setApplyModal] = useState<{ code: string; language: string } | null>(null);
  const [applyPath, setApplyPath] = useState('');
  const [applyStatus, setApplyStatus] = useState<'idle' | 'applying' | 'done' | 'error'>('idle');
  const [applyFileSuggestions, setApplyFileSuggestions] = useState<{ path: string }[]>([]);
  const [applyFileIndex, setApplyFileIndex] = useState(0);
  const applySearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledDraftInjectionRef = useRef<string | null>(null);
  const [queuedContextCards, setQueuedContextCards] = useState<QueuedContextCard[]>([]);

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
        const res = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`, {
          headers: buildRepoRequestHeaders(preferredRepo ?? null),
        });
        if (res.ok) {
          const data = await res.json();
          setApplyFileSuggestions(data.files ?? []);
          setApplyFileIndex(0);
        }
      } catch { /* ignore */ }
    }, 100);
  }, [preferredRepo]);

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
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(HISTORY_DELETED_EVENT, {
          detail: { tabId: histTabId },
        }));
      }
    } catch { /* ignore */ }
  }, []);

  // Open history panel
  useEffect(() => {
    if (historyOpen) loadHistory();
  }, [historyOpen, loadHistory]);

  useEffect(() => {
    const handleHistoryDeleted = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (!detail?.tabId || detail.tabId !== tabId) return;
      setMessages([]);
      setInput('');
      setStreamContent('');
      setIsStreaming(false);
      setShowTypingIndicator(false);
      setActiveToolCalls([]);
      setActiveThinking(null);
      setFollowUps([]);
      setAttachedFiles([]);
      setAttachedImages([]);
      setQueuedContextCards([]);
      setPendingApproval(null);
      setEditedCommand('');
      setApprovedToolsSet(new Set());
    };

    window.addEventListener(HISTORY_DELETED_EVENT, handleHistoryDeleted as EventListener);
    return () => window.removeEventListener(HISTORY_DELETED_EVENT, handleHistoryDeleted as EventListener);
  }, [tabId]);

  useEffect(() => {
    onSummaryChange?.(tabId, buildConversationSummary(messages));
  }, [messages, onSummaryChange, tabId]);

  useEffect(() => {
    if (!draftInjection?.id) return;
    if (handledDraftInjectionRef.current === draftInjection.id) return;
    handledDraftInjectionRef.current = draftInjection.id;
    if (draftInjection.autoSend) {
      setInput((current) => {
        const next = draftInjection.text.trim();
        if (!next) return current;
        return current.trim() ? `${next}\n\n${current}` : next;
      });
    } else {
      setQueuedContextCards((current) => {
        if (current.some((card) => card.id === draftInjection.id)) {
          return current;
        }
        return [...current, buildQueuedContextCard(draftInjection)];
      });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
    onConsumeDraftInjection?.(draftInjection.id);
  }, [draftInjection, onConsumeDraftInjection]);

  const doApply = useCallback(async () => {
    if (!applyModal || !applyPath.trim()) return;
    setApplyStatus('applying');
    try {
      const res = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: applyPath.trim(),
          content: applyModal.code,
          workspace: preferredRepo?.localPath ?? undefined,
        }),
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
  }, [applyModal, applyPath, preferredRepo]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildPersistedMessages = useCallback((baseMessages: LLMMessage[] = messages, partialContent: string = streamContent) => {
    const stableMessages = isStreaming
      ? baseMessages.filter((message) => !message.isPartial)
      : baseMessages;

    if (isStreaming && partialContent.trim()) {
      return [
        ...stableMessages,
        {
          id: `partial-${tabId}`,
          role: 'assistant' as const,
          content: partialContent,
          model: model.label,
          timestamp: Date.now(),
          isPartial: true,
        },
      ];
    }

    return stableMessages;
  }, [isStreaming, messages, model.label, streamContent, tabId]);

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
    if (!modelResolved) return;
    const persistedMessages = buildPersistedMessages();
    if (persistedMessages.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChatHistory(tabId, persistedMessages, model.id, preferredRepo ?? null);
    }, isStreaming ? 250 : 1000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [buildPersistedMessages, isStreaming, model.id, modelResolved, preferredRepo, tabId]);

  // Flush chat history on reload/navigation so in-flight assistant text survives page refresh.
  useEffect(() => {
    if (!modelResolved) return;
    const flushHistory = () => {
      const persistedMessages = buildPersistedMessages();
      if (persistedMessages.length === 0) return;
      void saveChatHistory(tabId, persistedMessages, model.id, preferredRepo ?? null);
    };
    window.addEventListener('pagehide', flushHistory);
    window.addEventListener('beforeunload', flushHistory);
    return () => {
      window.removeEventListener('pagehide', flushHistory);
      window.removeEventListener('beforeunload', flushHistory);
    };
  }, [buildPersistedMessages, model.id, modelResolved, preferredRepo, tabId]);

  // Auto-scroll on new messages (smooth, respects user scroll position)
  useEffect(() => {
    if (scrollRef.current && !isUserScrolledUp) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, streamContent, isUserScrolledUp]);

  // Track user scroll position
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setIsUserScrolledUp(distFromBottom > 100);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

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
          const res = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`, {
            headers: buildRepoRequestHeaders(preferredRepo ?? null),
          });
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
  }, [preferredRepo]);

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
    const text = [
      ...queuedContextCards.map((card) => card.text.trim()).filter(Boolean),
      input.trim(),
    ].filter(Boolean).join('\n\n');
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
          headers: {
            'Content-Type': 'application/json',
            ...buildRepoRequestHeaders(preferredRepo ?? null),
          },
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
    setQueuedContextCards([]);
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
    setShowTypingIndicator(true);
    setStreamContent('');
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Filter messages for API: skip error messages, empty content, and limit context
      const cleanMessages = messages
        .filter((m) => {
          // Skip error/system messages (they poison the conversation)
          if (m.isError) return false;
          if (m.isPartial) return false;
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
          { role: 'user', content: [buildLinkedIssueContext(linkedIssue), messageForModel].filter(Boolean).join('\n\n') },
        ],
        approvedTools: [...approvedToolsSet],
      });

      // Fetch with automatic retry on transient failures (dev server HMR, network blip)
      let res: Response | null = null;
      const retryDelays = [800, 1800];
      for (let attempt = 0; attempt < retryDelays.length + 1; attempt++) {
        try {
          res = await fetch('/api/v2/proxy/llm', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-tab-id': tabId,
              ...buildRepoRequestHeaders(preferredRepo ?? null),
            },
            body: reqBody,
            signal: controller.signal,
          });
          break; // Success — exit retry loop
        } catch (fetchErr) {
          if (attempt < retryDelays.length && !controller.signal.aborted) {
            await new Promise(r => setTimeout(r, retryDelays[attempt]));
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
      let recalledFacts = 0;
      let fallbackNotice = '';
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
                if (showTypingIndicator) setShowTypingIndicator(false);
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
                if (showTypingIndicator) setShowTypingIndicator(false);
                fullContent += parsed.text;
                setStreamContent(fullContent);
              } else if (parsed.type === 'usage') {
                tokens = { input: parsed.inputTokens, output: parsed.outputTokens };
                costUsd = parsed.costUsd;
              } else if (parsed.type === 'tool_call') {
                if (showTypingIndicator) setShowTypingIndicator(false);
                const existing = toolCalls.find(t => t.name === parsed.name);
                if (existing) {
                  existing.status = parsed.status;
                  existing.args = parsed.args ?? existing.args;
                } else {
                  toolCalls.push({ name: parsed.name, status: parsed.status, args: parsed.args });
                }
                setActiveToolCalls([...toolCalls]);
                // Add tool call as a thinking step — deduplicate same tool+args
                const toolLabel = parsed.name === 'search_web' ? `Searching "${parsed.args?.query || ''}"` :
                                  parsed.name === 'read_file' ? `Reading ${parsed.args?.path?.split('/').pop() || ''}` :
                                  parsed.name === 'search_code' ? `Searching code for "${parsed.args?.query || ''}"` :
                                  parsed.name === 'list_files' ? `Listing ${parsed.args?.path || '.'}` :
                                  parsed.name === 'create_github_issue' ? `Creating issue` :
                                  parsed.name === 'read_github_issue_or_pr' ? `Reading #${parsed.args?.number || ''}` :
                                  parsed.name === 'create_pull_request' ? `Creating PR` :
                                  `Running ${parsed.name}`;
                // Only add if we don't already have this exact step
                const existingStep = thinkingSteps.find(s => s.label === toolLabel);
                if (!existingStep) {
                  thinkingSteps.push({
                    type: parsed.name === 'search_web' || parsed.name === 'search_code' ? 'search' :
                          parsed.name === 'read_file' || parsed.name === 'list_files' ? 'reading' : 'tool',
                    label: toolLabel,
                    status: 'active',
                  });
                }
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
              } else if (parsed.type === 'memory_recall') {
                recalledFacts = parsed.factCount ?? 0;
                // Add a thinking step for memory recall
                if (recalledFacts > 0) {
                  thinkingSteps.push({
                    type: 'search',
                    label: `Recalled ${recalledFacts} memor${recalledFacts === 1 ? 'y' : 'ies'} from Cortex`,
                    status: 'complete',
                  });
                  setActiveThinking({ steps: [...thinkingSteps], thinking: thinkingText });
                }
              } else if (parsed.type === 'approval_required') {
                const isTerminal = parsed.name === 'run_terminal_command';
                setPendingApproval({
                  id: typeof parsed.id === 'string' ? parsed.id : undefined,
                  name: parsed.name,
                  args: parsed.args,
                  summary: parsed.summary,
                  editable: parsed.editable ?? isTerminal,
                  diff: parsed.diff,
                });
                if (isTerminal) {
                  setEditedCommand(String(parsed.args?.command || ''));
                }
              } else if (parsed.type === 'sources') {
                sources.push(...(parsed.sources ?? []));
              } else if (parsed.type === 'fallback') {
                // Model fallback — build a human-readable notice
                const origLabel = MODELS.find(m => m.id === parsed.originalModel)?.label ?? parsed.originalModel;
                const fbLabel = MODELS.find(m => m.id === parsed.fallbackModel)?.label ?? parsed.fallbackModel;
                fallbackNotice = `${origLabel} unavailable \u2014 using ${fbLabel}`;
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

      // Clean up content: strip tool narration lines the model adds before tool use
      const cleanContent = fullContent
        .replace(/^I'll use the \w+ tool[^\n]*\n*/gm, '')
        .replace(/^I'll use the \w+ tool[^\n]*/gm, '')
        .replace(/^Let me use[^\n]*tool[^\n]*\n*/gm, '')
        .trim();

      // Deduplicate sources by title+url
      const seenSources = new Set<string>();
      const uniqueSources = sources.filter(s => {
        const key = `${s.title}|${s.url ?? ''}`;
        if (seenSources.has(key)) return false;
        seenSources.add(key);
        return true;
      });

      // Add assistant message
      const assistantMsg: LLMMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        content: cleanContent,
        model: model.label,
        tokens,
        costUsd,
        timestamp: Date.now(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        sources: uniqueSources.length > 0 ? uniqueSources : undefined,
        thinking: thinkingText || undefined,
        thinkingSteps: thinkingSteps.length > 0 ? thinkingSteps.map(s => ({ ...s, status: 'complete' as const })) : undefined,
        thinkingDurationMs: thinkingSteps.length > 0 || thinkingText ? Date.now() - thinkingStartTime : undefined,
        recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
        fallbackNotice: fallbackNotice || undefined,
      };
      setMessages((prev) => {
        const updated = [...prev, assistantMsg];

        // Check if compaction should trigger
        if (shouldCompact(updated.length)) {
          // Fire async compaction — don't block the UI
          const msgsToCompact: CompactMessage[] = updated.map(m => ({
            id: m.id,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            timestamp: m.timestamp,
            isError: m.isError,
            isCompaction: m.isCompaction,
            compactedCount: m.compactedCount,
          }));

          compactConversation(msgsToCompact, tabId).then((result) => {
            if (result.compactedCount > 0) {
              setMessages(result.newMessages.map(cm => ({
                id: cm.id,
                role: cm.role as 'user' | 'assistant',
                content: cm.content,
                timestamp: cm.timestamp ?? Date.now(),
                isCompaction: cm.isCompaction,
                compactedCount: cm.compactedCount,
              })));
              console.log(`[compaction] Compressed ${result.compactedCount} messages`);
            }
          }).catch(err => {
            console.error('[compaction] Failed:', err);
          });
        }

        return updated;
      });
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
      setShowTypingIndicator(false);
      abortRef.current = null;
    }
  }, [approvedToolsSet, attachedFiles, attachedImages, input, isStreaming, linkedIssue, messages, model, preferredRepo, queuedContextCards, showTypingIndicator, streamContent, tabId]);

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

  const groupedHistory = (() => {
    const groups = new Map<string, typeof historyItems>();
    const repoOrder = new Map<string, number>();

    for (const item of historyItems) {
      const repoLabel = item.repoName?.trim()
        || item.repoPath?.trim()?.split('/').filter(Boolean).pop()
        || 'Unscoped';
      if (!groups.has(repoLabel)) {
        groups.set(repoLabel, []);
      }
      groups.get(repoLabel)!.push(item);
      const currentOrder = repoOrder.get(repoLabel) ?? 0;
      const timestamp = new Date(item.modifiedAt).getTime();
      repoOrder.set(repoLabel, Math.max(currentOrder, Number.isFinite(timestamp) ? timestamp : 0));
    }

    return [...groups.entries()]
      .sort((left, right) => {
        const preferredName = preferredRepo?.name?.trim();
        if (preferredName) {
          if (left[0] === preferredName && right[0] !== preferredName) return -1;
          if (right[0] === preferredName && left[0] !== preferredName) return 1;
        }
        return (repoOrder.get(right[0]) ?? 0) - (repoOrder.get(left[0]) ?? 0);
      })
      .map(([label, items]) => ({ label, items }));
  })();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      height: '100%',
      background: '#ffffff',
      fontFamily: '-apple-system, system-ui, sans-serif',
      overflow: 'hidden',
      '--t-text': '#111827',
      '--t-text-strong': '#1e293b',
      '--t-text-secondary': '#6b7280',
      '--t-text-muted': '#5b6475',
      '--t-text-faint': '#8b95a3',
      '--t-divider': 'rgba(0, 0, 0, 0.06)',
      '--t-divider-strong': 'rgba(0, 0, 0, 0.12)',
      '--t-panel-border': 'rgba(0, 0, 0, 0.08)',
      '--t-input-bg': '#ffffff',
      '--t-input-border': 'rgba(0, 0, 0, 0.1)',
    } as React.CSSProperties}>
      {/* ── History Sidebar ── */}
      <div style={{
        width: historyOpen ? 260 : 0,
        minWidth: historyOpen ? 260 : 0,
        borderRight: historyOpen ? '1px solid var(--t-divider)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 200ms ease, min-width 200ms ease',
        background: '#ffffff',
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
              borderBottom: '1px solid var(--t-divider)',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>History</span>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
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
                  border: '1px solid var(--t-panel-border)',
                  borderRadius: 8,
                  fontSize: 12,
                  outline: 'none',
                  boxSizing: 'border-box',
                  background: THEME_BG_CARD,
                  transition: 'border-color 150ms',
                }}
                onFocus={(e) => { (e.currentTarget).style.borderColor = THEME_ACCENT; }}
                onBlur={(e) => { (e.currentTarget).style.borderColor = 'var(--t-panel-border)'; }}
              />
            </div>

            {/* Conversation list */}
            <div className="cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
              {historyLoading ? (
                <div style={{ textAlign: 'center', paddingTop: 20, color: 'var(--t-text-muted)', fontSize: 12 }}>
                  Loading...
                </div>
              ) : historyItems.length === 0 ? (
                <div style={{ textAlign: 'center', paddingTop: 20, color: 'var(--t-text-muted)', fontSize: 12 }}>
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
                      color: 'var(--t-text-muted)',
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
                        onMouseEnter={(e) => { (e.currentTarget).style.background = THEME_ACCENT_SOFT; }}
                        onMouseLeave={(e) => { (e.currentTarget).style.background = 'transparent'; }}
                        onClick={() => {
                          if (onOpenHistoryChat) {
                            onOpenHistoryChat(conv.tabId, conv.title, conv.repoName || conv.repoPath ? {
                              name: conv.repoName ?? undefined,
                              localPath: conv.repoPath ?? undefined,
                              branch: conv.repoBranch ?? undefined,
                              remoteUrl: conv.remoteUrl ?? undefined,
                            } : null);
                          }
                        }}
                      >
                        <MessageSquare size={13} style={{ color: 'var(--t-text-muted)', marginTop: 2, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: 'var(--t-text)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {conv.title}
                          </div>
                          <div style={{
                            fontSize: 11,
                            color: 'var(--t-text-muted)',
                            marginTop: 2,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {[
                              conv.repoBranch ? `${conv.repoBranch}` : null,
                              `${conv.messageCount} msgs`,
                              conv.model.split('/').pop(),
                            ].filter(Boolean).join(' · ')}
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
                              color: conv.starred ? '#f59e0b' : 'var(--t-text-faint)',
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
                              color: 'var(--t-text-faint)',
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
        position: 'relative',
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
        borderBottom: '1px solid var(--t-divider)',
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
            background: historyOpen ? THEME_ACCENT_SOFT : 'transparent',
            color: historyOpen ? THEME_ACCENT : 'var(--t-text-muted)',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: '-apple-system, system-ui, sans-serif',
            transition: 'all 150ms',
          }}
          onMouseEnter={(e) => { if (!historyOpen) (e.currentTarget).style.background = THEME_BG_CARD; }}
          onMouseLeave={(e) => { if (!historyOpen) (e.currentTarget).style.background = 'transparent'; }}
        >
          <History size={14} />
        </button>

        <div style={{ flex: 1 }} />

        {/* Token/message counter */}
        {messages.length > 0 && (
          <span style={{
            fontSize: 11,
            color: 'var(--t-text-muted)',
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
                  <span style={{ color: 'var(--t-text-faint)' }}>·</span>
                  <span>{totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens} tokens</span>
                  {totalCost > 0 && (
                    <>
                      <span style={{ color: 'var(--t-text-faint)' }}>·</span>
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
        className="cortex-themed-scroll"
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
                fontSize: 28,
                fontWeight: 300,
                color: 'var(--t-text-secondary)',
                letterSpacing: '-0.03em',
                lineHeight: 1.2,
              }}>
                {(() => {
                  const h = new Date().getHours();
                  return h < 12 ? 'Good morning.' : h < 17 ? 'Good afternoon.' : 'Good evening.';
                })()}
              </div>
              <div style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--t-text-muted)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase' as const,
              }}>
                {model.label}
              </div>
            </div>

            {/* Suggested prompts — editorial grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 1,
              maxWidth: 520,
              width: '100%',
              border: '0.5px solid var(--t-divider-subtle)',
              borderRadius: 14,
              overflow: 'hidden',
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
                    paddingTop: 16,
                    paddingBottom: 16,
                    paddingLeft: 16,
                    paddingRight: 16,
                    background: 'transparent',
                    border: 'none',
                    borderRight: i % 2 === 0 ? '0.5px solid var(--t-divider-subtle)' : 'none',
                    borderBottom: i < 4 ? '0.5px solid var(--t-divider-subtle)' : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 150ms ease',
                    animation: `llmFadeIn 400ms ease-out ${100 + i * 50}ms both`,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget).style.background = 'rgba(37, 99, 235, 0.04)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget).style.background = 'transparent';
                  }}
                >
                  <div style={{ color: 'var(--t-text-faint)', marginTop: 1 }}>
                    <PromptIcon d={PROMPT_ICONS[prompt.iconKey]} size={16} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text-secondary)', letterSpacing: '-0.01em', lineHeight: '1.3' }}>
                      {prompt.text}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--t-text-muted)', lineHeight: '1.4', letterSpacing: '-0.005em' }}>
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
          {messages.map((msg, i) => {
            // Time separator — show when gap > 5 minutes between messages
            const prevMsg = i > 0 ? messages[i - 1] : null;
            const showTimeSep = prevMsg && (msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000);
            const timeLabel = showTimeSep ? new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;

            return (
              <div key={msg.id} style={{ animation: 'llmFadeIn 250ms ease-out' }}>
                {/* Time separator */}
                {showTimeSep && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    marginTop: 16,
                    marginBottom: 16,
                  }}>
                    <div style={{ flex: 1, height: 1, background: '#f1f5f9' }} />
                    <span style={{
                      fontSize: 11,
                      color: '#cbd5e1',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                      fontWeight: 500,
                      flexShrink: 0,
                    }}>
                      {timeLabel}
                    </span>
                    <div style={{ flex: 1, height: 1, background: '#f1f5f9' }} />
                  </div>
                )}
                {/* Compaction node — renders instead of regular bubble */}
                {msg.isCompaction ? (
                  <CompactionNode
                    compactedCount={msg.compactedCount ?? 0}
                    summary={msg.content}
                  />
                ) : (
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
                )}
              </div>
            );
          })}

          {/* Typing indicator — before first content arrives */}
          {showTypingIndicator && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 12,
              paddingBottom: 8,
              paddingLeft: 4,
              animation: 'llmFadeIn 200ms ease-out',
            }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#cbd5e1',
                  animation: `llmDot 1.4s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          )}

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
              {pendingApproval.name === 'run_terminal_command' ? '⚡' : pendingApproval.name === 'write_file' || pendingApproval.name === 'edit_file' ? '✏️' : pendingApproval.name === 'delete_file' ? '🗑️' : pendingApproval.name === 'create_github_issue' ? '📋' : '🔀'}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>
              {pendingApproval.name === 'run_terminal_command' ? 'Run Command?' : pendingApproval.name === 'edit_file' ? 'Apply Edit?' : pendingApproval.name === 'write_file' ? 'Write File?' : pendingApproval.name === 'delete_file' ? 'Delete File?' : 'Approval Required'}
            </span>
            {pendingApproval.name === 'run_terminal_command' && (
              <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>You can edit before running</span>
            )}
          </div>
          {/* Terminal command — editable input */}
          {pendingApproval.name === 'run_terminal_command' ? (
            <div style={{ marginBottom: 10 }}>
              <input
                type="text"
                value={editedCommand}
                onChange={(e) => setEditedCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editedCommand.trim()) {
                    // Trigger the main Approve button click
                    const approveBtn = document.querySelector('[data-approve-btn]') as HTMLButtonElement;
                    if (approveBtn) approveBtn.click();
                  } else if (e.key === 'Escape') {
                    setPendingApproval(null);
                  }
                }}
                autoFocus
                style={{
                  width: '100%',
                  paddingTop: 10,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 8,
                  border: '1px solid rgba(59,130,246,0.3)',
                  background: 'rgba(255,255,255,0.8)',
                  color: '#0f172a',
                  fontSize: 13,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {pendingApproval.args.cwd ? (
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                  Working directory: {String(pendingApproval.args.cwd)}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: '#475569', marginBottom: 10, lineHeight: 1.5 }}>
                {pendingApproval.summary}
              </div>

              {/* Diff preview for file operations */}
              {pendingApproval.diff ? (
                <div style={{
                  background: 'rgba(15,23,42,0.95)',
                  borderRadius: 8,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 0,
                  paddingRight: 0,
                  marginBottom: 10,
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  maxHeight: 200,
                  overflowY: 'auto',
                  overflowX: 'auto',
                }}>
                  {pendingApproval.diff.path && (
                    <div style={{ paddingLeft: 10, paddingBottom: 6, color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 4 }}>
                      {pendingApproval.diff.path}
                    </div>
                  )}
                  {(() => {
                    const before = (pendingApproval.diff?.before || '').split('\n');
                    const after = (pendingApproval.diff?.after || '').split('\n');
                    const isNewFile = !pendingApproval.diff?.before;
                    const isEdit = pendingApproval.name === 'edit_file';

                    if (isNewFile) {
                      // New file — show all lines as additions
                      return after.slice(0, 30).map((line, i) => (
                        <div key={i} style={{ paddingTop: 1, paddingBottom: 1, paddingLeft: 10, paddingRight: 10, background: 'rgba(52,211,153,0.08)', color: '#6ee7b7' }}>
                          <span style={{ color: '#34d399', marginRight: 8, userSelect: 'none' }}>+</span>{line}
                        </div>
                      ));
                    }

                    if (isEdit) {
                      // Edit — show removed and added lines
                      return (
                        <>
                          {before.map((line, i) => (
                            <div key={`r${i}`} style={{ paddingTop: 1, paddingBottom: 1, paddingLeft: 10, paddingRight: 10, background: 'rgba(96,165,250,0.08)', color: '#93c5fd', textDecoration: 'line-through', opacity: 0.7 }}>
                              <span style={{ color: '#60a5fa', marginRight: 8, userSelect: 'none' }}>−</span>{line}
                            </div>
                          ))}
                          {after.map((line, i) => (
                            <div key={`a${i}`} style={{ paddingTop: 1, paddingBottom: 1, paddingLeft: 10, paddingRight: 10, background: 'rgba(52,211,153,0.08)', color: '#6ee7b7' }}>
                              <span style={{ color: '#34d399', marginRight: 8, userSelect: 'none' }}>+</span>{line}
                            </div>
                          ))}
                        </>
                      );
                    }

                    // Full file overwrite — simplified diff
                    return after.slice(0, 30).map((line, i) => (
                      <div key={i} style={{ paddingTop: 1, paddingBottom: 1, paddingLeft: 10, paddingRight: 10, color: '#e2e8f0' }}>
                        {line}
                      </div>
                    ));
                  })()}
                  {(pendingApproval.diff?.after || '').split('\n').length > 30 && (
                    <div style={{ paddingLeft: 10, paddingTop: 4, color: '#64748b', fontStyle: 'italic' }}>
                      ... {(pendingApproval.diff?.after || '').split('\n').length - 30} more lines
                    </div>
                  )}
                </div>
              ) : pendingApproval.args && (pendingApproval.name === 'create_github_issue' || pendingApproval.name === 'create_pull_request' || pendingApproval.name === 'delete_file') ? (
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
                      {pendingApproval.args.labels ? (
                        <div><strong>Labels:</strong> {(pendingApproval.args.labels as string[]).join(', ')}</div>
                      ) : null}
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
                  {pendingApproval.name === 'delete_file' && (
                    <div style={{ color: '#ef4444' }}>
                      <strong>File:</strong> {String(pendingApproval.args.path)}
                    </div>
                  )}
                </div>
              ) : null}
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              data-approve-btn="true"
              onClick={() => {
                const approvalId = pendingApproval.id;
                const toolName = pendingApproval.name;
                const edited = pendingApproval.name === 'run_terminal_command' ? editedCommand.trim() : '';
                setPendingApproval(null);
                setApprovedToolsSet((current) => new Set([...current, toolName]));
                setIsStreaming(true);
                setShowTypingIndicator(true);
                setStreamContent('');
                setActiveThinking(null);

                fetch('/api/panel/approvals', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'approve',
                    id: approvalId,
                    editedCommand: edited || undefined,
                  }),
                }).then(async (res) => {
                  const data = await res.json().catch(() => null) as {
                    ok?: boolean;
                    note?: string;
                    assistantMessage?: LLMMessage | null;
                    nextApproval?: {
                      id?: string;
                      toolName?: string;
                      args?: Record<string, unknown>;
                      summary?: string;
                      editable?: boolean;
                      diff?: { before?: string; after?: string; path?: string };
                      command?: string;
                    } | null;
                    error?: string;
                  } | null;

                  if (!res.ok || !data?.ok) {
                    setMessages((prev) => [...prev, {
                      id: `approval-error-${Date.now()}`,
                      role: 'assistant',
                      content: `Error: ${data?.error || data?.note || 'Unable to approve this action.'}`,
                      timestamp: Date.now(),
                      isError: true,
                    }]);
                    return;
                  }

                  if (data.assistantMessage) {
                    setMessages((prev) => [...prev, data.assistantMessage as LLMMessage]);
                  }

                  if (data.nextApproval?.toolName) {
                    const isTerminal = data.nextApproval.toolName === 'run_terminal_command';
                    setPendingApproval({
                      id: data.nextApproval.id,
                      name: data.nextApproval.toolName,
                      args: data.nextApproval.args ?? {},
                      summary: data.nextApproval.summary ?? 'Approval required',
                      editable: data.nextApproval.editable ?? isTerminal,
                      diff: data.nextApproval.diff,
                    });
                    if (isTerminal) {
                      setEditedCommand(String(data.nextApproval.command || data.nextApproval.args?.command || ''));
                    }
                  }
                }).catch((error) => {
                  setMessages((prev) => [...prev, {
                    id: `approval-error-${Date.now()}`,
                    role: 'assistant',
                    content: `Error: ${error instanceof Error ? error.message : 'Unable to approve this action.'}`,
                    timestamp: Date.now(),
                    isError: true,
                  }]);
                }).finally(() => {
                  setStreamContent('');
                  setIsStreaming(false);
                  setShowTypingIndicator(false);
                });
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
                const approvalId = pendingApproval.id;
                const fallbackSummary = pendingApproval.summary;
                setPendingApproval(null);
                fetch('/api/panel/approvals', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'reject', id: approvalId }),
                }).then(async (res) => {
                  const data = await res.json().catch(() => null) as {
                    ok?: boolean;
                    assistantMessage?: LLMMessage | null;
                    note?: string;
                  } | null;
                  if (!res.ok || !data?.ok) {
                    setMessages((prev) => [...prev, {
                      id: `deny-${Date.now()}`,
                      role: 'assistant',
                      content: `Action cancelled: ${fallbackSummary}`,
                      timestamp: Date.now(),
                    }]);
                    return;
                  }
                  if (data.assistantMessage) {
                    setMessages((prev) => [...prev, data.assistantMessage as LLMMessage]);
                    return;
                  }
                  setMessages((prev) => [...prev, {
                    id: `deny-${Date.now()}`,
                    role: 'assistant',
                    content: data.note || `Action cancelled: ${fallbackSummary}`,
                    timestamp: Date.now(),
                  }]);
                }).catch(() => {
                  setMessages((prev) => [...prev, {
                    id: `deny-${Date.now()}`,
                    role: 'assistant',
                    content: `Action cancelled: ${fallbackSummary}`,
                    timestamp: Date.now(),
                  }]);
                });
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

      {/* Floating scroll-to-bottom pill */}
      {isUserScrolledUp && messages.length > 0 && (
        <div style={{
          position: 'absolute',
          right: 30,
          bottom: 104,
          zIndex: 50,
          animation: 'llmFadeIn 150ms ease-out',
        }}>
          <button
            type="button"
            onClick={() => {
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
              setIsUserScrolledUp(false);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              minHeight: 34,
              padding: '7px 12px',
              background: 'linear-gradient(180deg, rgba(239,246,255,0.94), rgba(191,219,254,0.72))',
              border: '1px solid rgba(96, 165, 250, 0.22)',
              borderRadius: 999,
              boxShadow: '0 12px 28px rgba(37, 99, 235, 0.16)',
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              color: '#1d4ed8',
              fontFamily: '-apple-system, system-ui, sans-serif',
              transition: 'all 150ms',
            }}
          >
            <ArrowDown size={13} />
            Bottom messages
          </button>
        </div>
      )}

      {/* Input area — bottom, ChatGPT style */}
      <div style={{
        paddingTop: 12,
        paddingBottom: 16,
        paddingLeft: 24,
        paddingRight: 24,
        borderTop: '1px solid var(--t-divider)',
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
            background: THEME_PANEL_GLASS,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 10,
            boxShadow: 'var(--t-panel-shadow)',
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
              color: 'var(--t-text-muted)',
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
                  background: i === filePickerIndex ? THEME_ACCENT_SOFT : 'transparent',
                  color: 'var(--t-text)',
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
            background: THEME_PANEL_GLASS,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            boxShadow: 'var(--t-panel-shadow)',
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
              color: 'var(--t-text-muted)',
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
                    background: i === slashIndex ? THEME_ACCENT_SOFT : 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 60ms',
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span style={{ fontSize: 16 }}>{cmd.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)' }}>
                      {cmd.command} <span style={{ fontWeight: 400, color: '#64748b' }}>{cmd.label}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{cmd.description}</div>
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
            border: '1px solid var(--t-panel-border)',
            borderRadius: 18,
            background: '#ffffff',
            transition: 'border-color 200ms, box-shadow 200ms',
            overflow: 'hidden',
          }}
          onFocus={(e) => {
            (e.currentTarget).style.borderColor = THEME_ACCENT;
            (e.currentTarget).style.boxShadow = `0 0 0 3px ${THEME_ACCENT_RING}`;
          }}
          onBlur={(e) => {
            (e.currentTarget).style.borderColor = 'var(--t-panel-border)';
            (e.currentTarget).style.boxShadow = 'none';
          }}
        >
          {queuedContextCards.length > 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                paddingTop: 14,
                paddingRight: 14,
                paddingBottom: 0,
                paddingLeft: 14,
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              {queuedContextCards.map((card) => (
                <div
                  key={card.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 12,
                    border: '1px solid var(--t-panel-border)',
                    background: THEME_BG_CARD,
                  }}
                >
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: 9,
                      background: THEME_ACCENT_SOFT,
                      color: THEME_ACCENT,
                      flexShrink: 0,
                    }}
                  >
                    <MessageSquare size={14} />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: THEME_ACCENT }}>
                      Staged Context
                    </div>
                    <div style={{ marginTop: 3, fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                      {card.title}
                    </div>
                    {card.meta.length > 0 ? (
                      <div style={{ marginTop: 3, display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 10, color: 'var(--t-text-muted)' }}>
                        {card.meta.slice(0, 2).map((entry) => (
                          <span key={entry}>{entry}</span>
                        ))}
                      </div>
                    ) : null}
                    {card.preview ? (
                      <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                        {card.preview}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setQueuedContextCards((current) => current.filter((queuedCard) => queuedCard.id !== card.id));
                    }}
                    aria-label="Remove staged context"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 28,
                      height: 28,
                      borderRadius: 9,
                      border: '1px solid var(--t-panel-border)',
                      background: 'transparent',
                      color: 'var(--t-text-faint)',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {/* Textarea area — upper portion */}
          <div style={{
            paddingTop: 14,
            paddingBottom: 8,
            paddingLeft: 18,
            paddingRight: 18,
          }}>
            <textarea
              name="llmChatMessage"
              aria-label={`Message ${model.label}`}
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
                color: 'var(--t-text)',
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
                  color: 'var(--t-text-muted)',
                  cursor: 'pointer',
                  transition: 'color 150ms, background 150ms',
                }}
                onMouseEnter={(e) => { (e.currentTarget).style.color = 'var(--t-text-secondary)'; (e.currentTarget).style.background = THEME_BG_CARD; }}
                onMouseLeave={(e) => { (e.currentTarget).style.color = 'var(--t-text-muted)'; (e.currentTarget).style.background = 'transparent'; }}
              >
                <Plus size={16} />
                <input
                  name="llmChatAttachments"
                  aria-label="Attach files"
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
                color: 'var(--t-text-faint)',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                @file · /cmds
              </span>
              <button
                type="button"
                onClick={() => setIssuePickerOpen(true)}
                title={linkedIssue ? linkedIssue.title : 'Link a GitHub issue to this chat'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  padding: '0 10px',
                  borderRadius: 999,
                  border: linkedIssue ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                  background: linkedIssue
                    ? THEME_ACCENT_SOFT
                    : THEME_BG_CARD,
                  color: linkedIssue ? THEME_ACCENT : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                <AlertCircle size={13} />
                {linkedIssue ? `Issue #${linkedIssue.number}` : 'Link issue'}
              </button>
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
                  disabled={!input.trim() && queuedContextCards.length === 0}
                  title="Send message (Enter)"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: input.trim() || queuedContextCards.length > 0 ? THEME_ACCENT : 'var(--t-divider-strong)',
                    color: input.trim() || queuedContextCards.length > 0 ? 'white' : 'var(--t-text-faint)',
                    cursor: input.trim() || queuedContextCards.length > 0 ? 'pointer' : 'default',
                    flexShrink: 0,
                    transition: 'all 150ms',
                  }}
                  onMouseEnter={(e) => { if (input.trim() || queuedContextCards.length > 0) (e.currentTarget).style.background = THEME_ACCENT; }}
                  onMouseLeave={(e) => { if (input.trim() || queuedContextCards.length > 0) (e.currentTarget).style.background = THEME_ACCENT; }}
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
          padding: 'var(--cortex-dialog-overlay-padding)',
          boxSizing: 'border-box',
          zIndex: 50,
          animation: 'llmFadeIn 150ms ease-out',
        }} onClick={() => setApplyModal(null)}>
          <div
            style={{
              background: 'white',
              borderRadius: 16,
              boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
              width: 'min(420px, 100%)',
              overflow: 'hidden',
              animation: 'llmFadeIn 200ms ease-out',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: 'var(--cortex-dialog-header-padding)',
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
            <div style={{ padding: 'var(--cortex-dialog-body-padding)', position: 'relative' }}>
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
              padding: 'var(--cortex-dialog-footer-padding)',
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

      <IssueLinkPickerModal
        open={issuePickerOpen}
        onClose={() => setIssuePickerOpen(false)}
        value={linkedIssue}
        preferredRepo={preferredRepo ?? null}
        onSelect={(issue) => onLinkedIssueChange?.(issue)}
        onClear={() => onLinkedIssueChange?.(null)}
      />
    </div>
    </div>
  );
}
