'use client';

/**
 * MessageActions — inline action bar under each agent message.
 *
 * Always visible, minimal icons. Play, Copy, Retry, More.
 * Desktop version — separate from mobile (per our component rule).
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

export const MessageActions = memo(function MessageActions({
  messageId,
  messageText,
  onRetry,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [ttsState, setTtsState] = useState<PlaybackState>('idle');
  const [isThisMessage, setIsThisMessage] = useState(false);

  // Subscribe to TTS engine state
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
      // Strip markdown for clipboard
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
      // Fallback
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

  // Play button icon/state
  const playIcon = (() => {
    if (ttsState === 'loading') return <Volume2 size={14} strokeWidth={1.8} className="spin" />;
    if (ttsState === 'playing') return <Pause size={14} strokeWidth={1.8} />;
    return <Play size={14} strokeWidth={1.8} />;
  })();

  const playLabel = (() => {
    if (ttsState === 'loading') return 'Loading…';
    if (ttsState === 'playing') return 'Pause';
    if (ttsState === 'paused') return 'Resume';
    return 'Play';
  })();

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      marginTop: 6,
      opacity: 0.45,
      transition: 'opacity 180ms ease',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
    onMouseLeave={(e) => {
      // Stay visible if this message is actively playing
      e.currentTarget.style.opacity = isThisMessage && ttsState !== 'idle' ? '1' : '0.45';
    }}
    >
      {/* Play */}
      <button
        type="button"
        onClick={handlePlay}
        title={playLabel}
        aria-label={playLabel}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 7,
          border: 'none',
          background: isThisMessage && ttsState !== 'idle' ? 'rgba(37, 99, 235, 0.1)' : 'transparent',
          color: isThisMessage && ttsState !== 'idle' ? '#2563eb' : '#8e8e93',
          cursor: 'pointer',
          transition: 'all 150ms ease',
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
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 7,
          border: 'none',
          background: copied ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
          color: copied ? '#22c55e' : '#8e8e93',
          cursor: 'pointer',
          transition: 'all 150ms ease',
        }}
      >
        {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
      </button>

      {/* Retry */}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          title="Retry"
          aria-label="Retry"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 7,
            border: 'none',
            background: 'transparent',
            color: '#8e8e93',
            cursor: 'pointer',
            transition: 'all 150ms ease',
          }}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
        </button>
      ) : null}

      {/* More */}
      <button
        type="button"
        title="More actions"
        aria-label="More actions"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 7,
          border: 'none',
          background: 'transparent',
          color: '#8e8e93',
          cursor: 'pointer',
          transition: 'all 150ms ease',
        }}
      >
        <MoreHorizontal size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
});
