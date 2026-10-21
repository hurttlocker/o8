export type DictationState =
  | 'idle'
  | 'requesting-mic'
  | 'recording'
  | 'transcribing'
  | 'polishing'
  | 'success'
  | 'error';

export interface DictationStartOptions {
  /** A visual capture can request measured on-device word ranges without changing ordinary dictation. */
  timedCaptureId?: string;
  onRecordingStart?: (startedAtMs: number) => void;
  /** Visual evidence keeps the recognized words instead of rewriting their meaning. */
  preserveTranscript?: boolean;
  /** Hint surface — used by the polish prompt for context. */
  surface?: 'orchestrator' | 'chat' | 'terminal' | 'general';
  /** Optional context to pass to polish — e.g. open file paths. */
  context?: { openFiles?: string[]; activeRepoPath?: string | null };
  /** Fired with the final polished text when complete. */
  onComplete: (polishedText: string, words?: TimedDictationWord[]) => void;
  /** Fired if cancelled or if anything fails. Receives error message or null on cancel. */
  onAbort?: (reason: string | null) => void;
}

export interface TimedDictationWord { t0: number; t1: number; text: string }

export interface DictationSnapshot {
  state: DictationState;
  /** 0..1 RMS level for waveform driving. */
  audioLevel: number;
  /** Recording duration ms. Resets on each recording. */
  durationMs: number;
  /** Active error message, if any. */
  error: string | null;
  /**
   * Live partial transcript while recording. Powered by the browser's
   * SpeechRecognition API — runs locally for free, separate from the
   * canonical Whisper pass. Empty string when unavailable / silent.
   */
  partialTranscript: string;
  /**
   * The final pasted text, set on the `system-pasted` success flash so the
   * screen dock shows the actual words (Symon parity) instead of a generic
   * "Pasted". Dock-only; the in-window pill ignores it. Undefined elsewhere.
   */
  pastedText?: string | null;
}
