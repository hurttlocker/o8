/**
 * TTSEngine — unified TTS playback for Cortex IDE.
 *
 * Layer 1: Server-side edge-tts via /api/tts (en-US-SteffanNeural = Mister voice)
 * Layer 2: Browser SpeechSynthesis (offline fallback, device voice)
 *
 * Used by both desktop and mobile message action bars.
 */

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

  /** Play a message. Tries server-side edge-tts first, falls back to SpeechSynthesis. */
  async play(text: string, messageId: string): Promise<void> {
    this.stop();

    this.updateState({
      state: 'loading',
      activeMessageId: messageId,
      currentTime: 0,
      duration: 0,
      usingFallback: false,
    });

    const cleanText = stripMarkdown(text);

    // Try server-side edge-tts
    try {
      console.log('[TTS] Requesting /api/tts...');
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText, voice: 'en-US-SteffanNeural' }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`TTS API ${resp.status}: ${errText}`);
      }

      const blob = await resp.blob();
      console.log(`[TTS] Got audio: ${blob.size} bytes`);

      if (this._state.activeMessageId !== messageId) {
        return; // Stopped during request
      }

      const blobUrl = URL.createObjectURL(blob);
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
        console.warn('[TTS] Audio playback error, trying fallback');
        this.cleanup();
        this.playFallback(cleanText, messageId);
      };

      await this.audio.play();
      console.log('[TTS] Playing Mister voice (SteffanNeural)');
      return;
    } catch (err) {
      console.warn('[TTS] Server-side TTS failed, using fallback:', err);
      this.playFallback(cleanText, messageId);
    }
  }

  /** Fallback: browser SpeechSynthesis API */
  private playFallback(text: string, messageId: string) {
    if (!('speechSynthesis' in window)) {
      this.updateState({ state: 'error', activeMessageId: null });
      return;
    }

    console.log('[TTS] Using SpeechSynthesis fallback');
    this.updateState({
      state: 'playing',
      activeMessageId: messageId,
      usingFallback: true,
    });

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this._state.playbackRate;
    utterance.lang = 'en-US';

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
    if (this.audio) this.audio.playbackRate = rate;
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

/** Strip markdown for cleaner speech */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\|/g, ', ')
    .replace(/^[\s-:]+$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/─\s*\w+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const ttsEngine = new TTSEngineImpl();
