'use client';

/**
 * ChatOpenRouterPicker — chip + popover dropdown for picking the
 * OpenRouter model used by Chat-mode tabs.
 *
 * Only mounted when the Chat tab is active (lockedMode === 'chat').
 * The selected model overrides the server-side fallback chain via the
 * `modelOverride` request body field. The "auto" option clears the
 * pin and falls back to the env-configured chain (default
 * `openai/gpt-oss-120b:free` for tool-capable testing).
 *
 * Models are tagged with whether OpenAI function calling is known to
 * work — the chat-mode flow needs tools so the operator can quickly
 * see which models will actually exercise the tool path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ChatOpenRouterPickerProps {
  selectedSlug: string | undefined;
  onSelect: (slug: string | null) => void;
}

interface OpenRouterModelOption {
  slug: string;
  label: string;
  vendor: string;
  toolsLikely: boolean;
  notes?: string;
}

const AUTO_LABEL = 'Auto';
const AUTO_DESCRIPTION = 'Use the env-configured chain (default: GPT-OSS 120B free).';
const POPOVER_GAP = 6;
const POPOVER_WIDTH = 340;
const POPOVER_ESTIMATED_HEIGHT = 194;

const OPENROUTER_MODELS: OpenRouterModelOption[] = [
  {
    slug: 'openai/gpt-oss-120b:free',
    label: 'GPT-OSS 120B',
    vendor: 'OpenAI',
    toolsLikely: true,
    notes: 'Free tier · function calling supported',
  },
  {
    slug: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    vendor: 'DeepSeek',
    toolsLikely: true,
    notes: 'Paid · fast tier · function calling supported',
  },
  {
    slug: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    toolsLikely: true,
    notes: 'Paid · top tier · function calling supported',
  },
];

function findOption(slug: string | undefined): OpenRouterModelOption | null {
  if (!slug) return null;
  return OPENROUTER_MODELS.find((option) => option.slug === slug) ?? null;
}

export function ChatOpenRouterPicker({ selectedSlug, onSelect }: ChatOpenRouterPickerProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const matched = findOption(selectedSlug);
  const labelText = matched?.label ?? AUTO_LABEL;

  const handleToggle = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setAnchorRect(rect);
    setOpen((prev) => !prev);
  }, []);

  const handlePick = useCallback((slug: string | null) => {
    onSelect(slug);
    setOpen(false);
  }, [onSelect]);

  // Close on outside click + escape
  useEffect(() => {
    if (!open) return;
    const refreshAnchor = () => {
      if (!buttonRef.current) return;
      setAnchorRect(buttonRef.current.getBoundingClientRect());
    };
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (buttonRef.current?.contains(target)) return;
      const popover = document.getElementById('o8-chat-openrouter-popover');
      if (popover?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('resize', refreshAnchor);
    window.addEventListener('scroll', refreshAnchor, true);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', refreshAnchor);
      window.removeEventListener('scroll', refreshAnchor, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        title={matched?.notes ?? AUTO_DESCRIPTION}
        style={{
          height: 26,
          paddingTop: 0,
          paddingRight: 9,
          paddingBottom: 0,
          paddingLeft: 9,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-border)',
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: '-0.005em',
          flexShrink: 0,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <ModelIcon />
        <span>{labelText}</span>
        <Caret open={open} />
      </button>
      {open && anchorRect && typeof document !== 'undefined'
        ? createPortal(
            <ChatOpenRouterPopover
              anchorRect={anchorRect}
              selectedSlug={selectedSlug ?? null}
              onPick={handlePick}
            />,
            document.body,
          )
        : null}
    </>
  );
}

interface PopoverProps {
  anchorRect: DOMRect;
  selectedSlug: string | null;
  onPick: (slug: string | null) => void;
}

function ChatOpenRouterPopover({ anchorRect, selectedSlug, onPick }: PopoverProps) {
  const viewportWidth = typeof window === 'undefined' ? POPOVER_WIDTH + 16 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight;
  const spaceBelow = viewportHeight - anchorRect.bottom;
  const opensUp = spaceBelow < POPOVER_ESTIMATED_HEIGHT + POPOVER_GAP + 8;
  const maxHeight = Math.max(156, Math.min(POPOVER_ESTIMATED_HEIGHT, viewportHeight - 16));
  const top = opensUp
    ? Math.max(8, anchorRect.top - maxHeight - POPOVER_GAP)
    : Math.min(anchorRect.bottom + POPOVER_GAP, viewportHeight - maxHeight - 8);
  const left = Math.min(
    Math.max(8, anchorRect.left),
    Math.max(8, viewportWidth - POPOVER_WIDTH - 8),
  );
  return (
    <div
      id="o8-chat-openrouter-popover"
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 9999,
        width: POPOVER_WIDTH,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight,
        overflowY: 'auto',
        paddingTop: 4,
        paddingRight: 4,
        paddingBottom: 4,
        paddingLeft: 4,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        background: 'var(--t-panel)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        boxShadow: 'var(--t-panel-shadow)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <PopoverRow
        label={AUTO_LABEL}
        sub={AUTO_DESCRIPTION}
        selected={selectedSlug === null}
        onClick={() => onPick(null)}
        toolsBadge={null}
      />
      <div
        style={{
          height: 1,
          background: 'var(--t-divider-subtle)',
          marginTop: 4,
          marginBottom: 4,
          marginLeft: 6,
          marginRight: 6,
        }}
      />
      {OPENROUTER_MODELS.map((option) => (
        <PopoverRow
          key={option.slug}
          label={option.label}
          sub={`${option.vendor} · ${option.notes ?? option.slug}`}
          selected={selectedSlug === option.slug}
          onClick={() => onPick(option.slug)}
          toolsBadge={option.toolsLikely ? 'tools' : 'no-tools'}
        />
      ))}
    </div>
  );
}

interface PopoverRowProps {
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
  toolsBadge: 'tools' | 'no-tools' | null;
}

function PopoverRow({ label, sub, selected, onClick, toolsBadge }: PopoverRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        width: '100%',
        height: 42,
        paddingTop: 4,
        paddingRight: 10,
        paddingBottom: 4,
        paddingLeft: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: selected ? 'var(--t-brand-orange, #FF5A1F)' : 'transparent',
        background: selected ? 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 10%, transparent)' : 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (selected) return;
        event.currentTarget.style.background = 'var(--t-bg-card)';
      }}
      onMouseLeave={(event) => {
        if (selected) return;
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--t-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sub}
        </span>
      </span>
      {toolsBadge ? <ToolsBadge tone={toolsBadge} /> : null}
    </button>
  );
}

function ToolsBadge({ tone }: { tone: 'tools' | 'no-tools' }) {
  const positive = tone === 'tools';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 18,
        minWidth: 56,
        paddingTop: 0,
        paddingRight: 6,
        paddingBottom: 0,
        paddingLeft: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: positive
          ? 'color-mix(in srgb, var(--t-terminal-ansi-green) 28%, transparent)'
          : 'var(--t-border)',
        background: positive
          ? 'color-mix(in srgb, var(--t-terminal-ansi-green) 12%, transparent)'
          : 'var(--t-bg-card)',
        color: positive ? 'var(--t-terminal-ansi-green)' : 'var(--t-text-muted)',
        fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.04em',
        flexShrink: 0,
        textTransform: 'uppercase',
      }}
    >
      {positive ? 'tools' : 'text only'}
    </span>
  );
}

function ModelIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="m5.6 5.6 2.1 2.1" />
      <path d="m16.3 16.3 2.1 2.1" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="m5.6 18.4 2.1-2.1" />
      <path d="m16.3 7.7 2.1-2.1" />
    </svg>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        display: 'block',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
