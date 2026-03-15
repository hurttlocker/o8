/**
 * TTSEngine — unified TTS playback for Cortex IDE.
 *
 * Layer 1: Edge TTS WebSocket (browser-direct, en-US-SteffanNeural)
 * Layer 2: Browser SpeechSynthesis (offline fallback, device voice)
 *
 * Used by both desktop and mobile message action bars.
 */

import { synthesize } from './edge-ws';

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface TTSEngineState {
  state: PlaybackState;
  currentTime: number;
  duration: number;
  playbackRate: number;
  activeMessageId: string | null;
  usingFallback: boolean;
}

type StateListener = (state: TTSEngineState) => void;

class TTSEngineImpl {
  private audio: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private listeners = new Set<StateListener>();
  private _state: TTSEngineState = {
    state: 'idle',
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    activeMessageId: null,
    usingFallback: false,
  };
  private animFrameId: number | null = null;

  /** Subscribe to state changes. Returns unsubscribe function. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this._state);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) {
      listener({ ...this._state });
    }
  }

  private updateState(patch: Partial<TTSEngineState>) {
    Object.assign(this._state, patch);
    this.emit();
  }

  private startTimeTracking() {
    const tick = () => {
      if (this.audio && this._state.state === 'playing') {
        this.updateState({
          currentTime: this.audio.currentTime,
          duration: this.audio.duration || 0,
        });
      }
      this.animFrameId = requestAnimationFrame(tick);
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopTimeTracking() {
    if (this.animFrameId != null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /** Play a message. Tries Edge TTS first, falls back to SpeechSynthesis. */
  async play(text: string, messageId: string): Promise<void> {
    // Stop any current playback
    this.stop();

    this.updateState({
      state: 'loading',
      activeMessageId: messageId,
      currentTime: 0,
      duration: 0,
      usingFallback: false,
    });

    // Strip markdown formatting for cleaner speech
    const cleanText = stripMarkdown(text);

    // Try Edge TTS first
    try {
      const blobUrl = await synthesize(cleanText, {
        voice: 'en-US-SteffanNeural',
      });

      // Double-check we weren't stopped during synthesis
      if (this._state.activeMessageId !== messageId) {
        URL.revokeObjectURL(blobUrl);
        return;
      }

      this.currentBlobUrl = blobUrl;
      this.audio = new Audio(blobUrl);
      this.audio.playbackRate = this._state.playbackRate;

      this.audio.onplay = () => {
        this.updateState({ state: 'playing' });
        this.startTimeTracking();
      };

      this.audio.onpause = () => {
        if (this._state.state !== 'idle') {
          this.updateState({ state: 'paused' });
        }
      };

      this.audio.onended = () => {
        this.cleanup();
        this.updateState({
          state: 'idle',
          activeMessageId: null,
          currentTime: 0,
          duration: 0,
        });
      };

      this.audio.onerror = () => {
        this.cleanup();
        // Fall through to SpeechSynthesis
        this.playFallback(cleanText, messageId);
      };

      await this.audio.play();
      return;
    } catch {
      // Edge TTS failed — fall back to SpeechSynthesis
      this.playFallback(cleanText, messageId);
    }
  }

  /** Fallback: browser SpeechSynthesis API */
  private playFallback(text: string, messageId: string) {
    if (!('speechSynthesis' in window)) {
      this.updateState({ state: 'error', activeMessageId: null });
      return;
    }

    this.updateState({
      state: 'playing',
      activeMessageId: messageId,
      usingFallback: true,
    });

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this._state.playbackRate;
    utterance.lang = 'en-US';

    // Try to pick a good voice
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Samantha'))
      ?? voices.find(v => v.name.includes('Daniel'))
      ?? voices.find(v => v.lang === 'en-US' && v.localService);
    if (preferred) utterance.voice = preferred;

    utterance.onend = () => {
      this.updateState({
        state: 'idle',
        activeMessageId: null,
        currentTime: 0,
        duration: 0,
      });
    };

    utterance.onerror = () => {
      this.updateState({ state: 'error', activeMessageId: null });
    };

    this.utterance = utterance;
    speechSynthesis.speak(utterance);
  }

  pause() {
    if (this.audio && this._state.state === 'playing') {
      this.audio.pause();
    } else if (this.utterance && this._state.state === 'playing') {
      speechSynthesis.pause();
      this.updateState({ state: 'paused' });
    }
  }

  resume() {
    if (this.audio && this._state.state === 'paused') {
      void this.audio.play();
    } else if (this.utterance && this._state.state === 'paused') {
      speechSynthesis.resume();
      this.updateState({ state: 'playing' });
    }
  }

  stop() {
    this.cleanup();
    this.updateState({
      state: 'idle',
      activeMessageId: null,
      currentTime: 0,
      duration: 0,
    });
  }

  seek(seconds: number) {
    if (this.audio && Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
    }
  }

  seekRelative(delta: number) {
    if (this.audio && Number.isFinite(this.audio.duration)) {
      this.seek(this.audio.currentTime + delta);
    }
  }

  setRate(rate: number) {
    this.updateState({ playbackRate: rate });
    if (this.audio) {
      this.audio.playbackRate = rate;
    }
    if (this.utterance) {
      // SpeechSynthesis rate can't be changed mid-utterance
      // Will apply on next play
    }
  }

  get state(): TTSEngineState {
    return { ...this._state };
  }

  private cleanup() {
    this.stopTimeTracking();

    if (this.audio) {
      this.audio.pause();
      this.audio.onplay = null;
      this.audio.onpause = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio = null;
    }

    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    if (this.utterance) {
      speechSynthesis.cancel();
      this.utterance = null;
    }
  }
}

/** Strip markdown formatting for cleaner speech */
function stripMarkdown(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove table formatting
    .replace(/\|/g, ', ')
    .replace(/^[\s-:]+$/gm, '')
    // Remove link formatting
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Clean up model signatures
    .replace(/─\s*\w+$/gm, '')
    // Collapse whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Singleton instance
export const ttsEngine = new TTSEngineImpl();
