'use client';

/**
 * MessageActions — inline action bar under each agent message.
 *
 * Default mode:  ▶ Play  📋 Copy  ↻ Retry  ··· More
 * Playing mode:  ⏪ 10s  ⏸ Pause  ⏩ 10s  1x  0:24/1:47  ■ Stop
 *
 * The row morphs in place — zero new UI elements (Option A).
 * Option B (floating pill) filed for later enhancement.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Square,
  Volume2,
} from 'lucide-react';
import { ttsEngine, type PlaybackState, type TTSEngineState } from '@/lib/tts/engine';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';

interface MessageActionsProps {
  messageId: string;
  messageText: string;
  onRetry?: () => void;
}

const iconBtnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '1px solid var(--t-panel-border)',
  background: THEME_BG_CARD,
  color: 'var(--t-text-secondary)',
  cursor: 'pointer',
  transition: 'all 150ms ease',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

const RATES = [1, 1.25, 1.5, 2];

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export const MessageActions = memo(function MessageActions({
  messageId,
  messageText,
  onRetry,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [ttsState, setTtsState] = useState<PlaybackState>('idle');
  const [isThisMessage, setIsThisMessage] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    return ttsEngine.subscribe((state: TTSEngineState) => {
      const active = state.activeMessageId === messageId;
      setIsThisMessage(active);
      setTtsState(active ? state.state : 'idle');
      if (active) {
        setCurrentTime(state.currentTime);
        setDuration(state.duration);
        setRate(state.playbackRate);
      }
    });
  }, [messageId]);

  const handlePlay = useCallback(() => {
    if (isThisMessage && (ttsState === 'playing' || ttsState === 'loading')) {
      ttsEngine.pause();
    } else if (isThisMessage && ttsState === 'paused') {
      ttsEngine.resume();
    } else {
      void ttsEngine.play(messageText, messageId);
    }
  }, [messageId, messageText, isThisMessage, ttsState]);

  const handleCopy = useCallback(async () => {
    try {
      const clean = messageText
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/─\s*\w+$/gm, '')
        .trim();
      await navigator.clipboard.writeText(clean);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = messageText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [messageText]);

  const isTransport = isThisMessage && (ttsState === 'playing' || ttsState === 'paused' || ttsState === 'loading');

  // ── Transport mode: ⏪ ⏸ ⏩ 1x 0:24/1:47 ■ ──
  if (isTransport) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          marginTop: 8,
          paddingTop: 6,
          borderTop: '1px solid var(--t-divider)',
        }}
      >
        {/* Back 10s */}
        <button
          type="button"
          onClick={() => ttsEngine.seekRelative(-10)}
          title="Back 10s"
          aria-label="Back 10 seconds"
          style={{ ...iconBtnBase, color: THEME_ACCENT }}
        >
          <RotateCcw size={15} strokeWidth={1.8} />
        </button>

        {/* Pause / Resume */}
        <button
          type="button"
          onClick={() => {
            if (ttsState === 'playing') ttsEngine.pause();
            else ttsEngine.resume();
          }}
          title={ttsState === 'playing' ? 'Pause' : 'Resume'}
          aria-label={ttsState === 'playing' ? 'Pause' : 'Resume'}
          style={{
          ...iconBtnBase,
          width: 36,
          height: 36,
          background: THEME_ACCENT_SOFT,
          borderColor: THEME_ACCENT_BORDER,
            color: THEME_ACCENT,
          }}
        >
          {ttsState === 'loading' ? (
            <Volume2 size={17} strokeWidth={1.8} className="spin" />
          ) : ttsState === 'playing' ? (
            <Pause size={17} strokeWidth={2} />
          ) : (
            <Play size={17} strokeWidth={2} />
          )}
        </button>

        {/* Forward 10s */}
        <button
          type="button"
          onClick={() => ttsEngine.seekRelative(10)}
          title="Forward 10s"
          aria-label="Forward 10 seconds"
          style={{ ...iconBtnBase, color: THEME_ACCENT }}
        >
          <RotateCw size={15} strokeWidth={1.8} />
        </button>

        {/* Speed */}
        <button
          type="button"
          onClick={() => {
            const nextIdx = (RATES.indexOf(rate) + 1) % RATES.length;
            ttsEngine.setRate(RATES[nextIdx]);
          }}
          title={`Speed: ${rate}x (click to change)`}
          aria-label={`Playback speed ${rate}x`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 'auto',
            height: 32,
            borderRadius: 8,
            border: '1px solid transparent',
            background: 'transparent',
            cursor: 'pointer',
            transition: 'all 150ms ease',
            paddingTop: 0,
            paddingRight: 6,
            paddingBottom: 0,
            paddingLeft: 6,
            fontSize: 11,
            fontWeight: 700,
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            color: rate === 1 ? 'var(--t-text-faint)' : THEME_ACCENT,
          }}
        >
          {rate}x
        </button>

        {/* Time */}
        <span style={{
          fontSize: 11,
          fontWeight: 500,
          color: 'var(--t-text-faint)',
          fontFamily: 'SF Mono, ui-monospace, monospace',
          letterSpacing: '-0.02em',
          marginLeft: 2,
          minWidth: 70,
          textAlign: 'center',
        }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Stop */}
        <button
          type="button"
          onClick={() => ttsEngine.stop()}
          title="Stop"
          aria-label="Stop playback"
        style={{
          ...iconBtnBase,
          marginLeft: 'auto',
          color: '#ef4444',
          }}
        >
          <Square size={14} strokeWidth={2} fill="#ef4444" />
        </button>
      </div>
    );
  }

  // ── Default mode: ▶ 📋 ↻ ··· ──
  return (
    <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 8,
          paddingTop: 4,
          borderTop: '1px solid var(--t-divider-subtle)',
        }}
      >
      <button
        type="button"
        onClick={handlePlay}
        title="Play"
        aria-label="Play"
        style={{ ...iconBtnBase }}
      >
        <Play size={16} strokeWidth={1.8} />
      </button>

      <button
        type="button"
        onClick={() => void handleCopy()}
        title={copied ? 'Copied!' : 'Copy'}
        aria-label="Copy message"
        style={{
          ...iconBtnBase,
          background: copied ? 'rgba(34, 197, 94, 0.08)' : THEME_BG_CARD,
          borderColor: copied ? 'rgba(34, 197, 94, 0.15)' : 'var(--t-panel-border)',
          color: copied ? '#22c55e' : 'var(--t-text-secondary)',
        }}
      >
        {copied ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.8} />}
      </button>

      <button
        type="button"
        onClick={onRetry ?? (() => {})}
        title="Retry"
        aria-label="Retry"
        style={{ ...iconBtnBase }}
      >
        <RefreshCw size={16} strokeWidth={1.8} />
      </button>

      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        style={{ ...iconBtnBase }}
      >
        <MoreHorizontal size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
});
