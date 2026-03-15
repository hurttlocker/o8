'use client';

/**
 * MessageActions — inline action bar under each agent message.
 *
 * Always visible, icon-only row: ▶ Play, 📋 Copy, ↻ Retry, ··· More.
 * Mobile version — separate from desktop (per our component rule).
 */

import { memo, useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { ttsEngine, type PlaybackState } from '@/lib/tts/engine';

interface MessageActionsProps {
  messageId: string;
  messageText: string;
  onRetry?: () => void;
}

const iconBtnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid transparent',
  background: 'transparent',
  color: '#9ca3af',
  cursor: 'pointer',
  transition: 'all 150ms ease',
  padding: 0,
  WebkitTapHighlightColor: 'transparent',
};

export const MessageActions = memo(function MessageActions({
  messageId,
  messageText,
  onRetry,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [ttsState, setTtsState] = useState<PlaybackState>('idle');
  const [isThisMessage, setIsThisMessage] = useState(false);

  useEffect(() => {
    return ttsEngine.subscribe((state) => {
      const active = state.activeMessageId === messageId;
      setIsThisMessage(active);
      setTtsState(active ? state.state : 'idle');
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
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [messageText]);

  const playActive = isThisMessage && ttsState !== 'idle';

  const playIcon = (() => {
    if (ttsState === 'loading') return <Volume2 size={16} strokeWidth={1.8} className="spin" />;
    if (ttsState === 'playing') return <Pause size={16} strokeWidth={1.8} />;
    return <Play size={16} strokeWidth={1.8} />;
  })();

  const playTitle = (() => {
    if (ttsState === 'loading') return 'Loading…';
    if (ttsState === 'playing') return 'Pause';
    if (ttsState === 'paused') return 'Resume';
    return 'Play';
  })();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 8,
        paddingTop: 4,
        borderTop: '1px solid rgba(0,0,0,0.04)',
      }}
    >
      {/* Play */}
      <button
        type="button"
        onClick={handlePlay}
        title={playTitle}
        aria-label={playTitle}
        style={{
          ...iconBtnBase,
          background: playActive ? 'rgba(37, 99, 235, 0.08)' : undefined,
          borderColor: playActive ? 'rgba(37, 99, 235, 0.15)' : undefined,
          color: playActive ? '#2563eb' : '#6b7280',
        }}
      >
        {playIcon}
      </button>

      {/* Copy */}
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={copied ? 'Copied!' : 'Copy'}
        aria-label="Copy message"
        style={{
          ...iconBtnBase,
          background: copied ? 'rgba(34, 197, 94, 0.08)' : undefined,
          borderColor: copied ? 'rgba(34, 197, 94, 0.15)' : undefined,
          color: copied ? '#22c55e' : '#6b7280',
        }}
      >
        {copied ? <Check size={16} strokeWidth={2} /> : <Copy size={16} strokeWidth={1.8} />}
      </button>

      {/* Retry */}
      <button
        type="button"
        onClick={onRetry ?? (() => {})}
        title="Retry"
        aria-label="Retry"
        style={{
          ...iconBtnBase,
          color: '#6b7280',
        }}
      >
        <RefreshCw size={16} strokeWidth={1.8} />
      </button>

      {/* More */}
      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        style={{
          ...iconBtnBase,
          color: '#6b7280',
        }}
      >
        <MoreHorizontal size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
});
