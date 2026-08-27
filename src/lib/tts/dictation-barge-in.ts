import { ttsEngine, type TTSEngineState } from './engine';

interface TtsStopTarget {
  state: TTSEngineState;
  stop: () => void;
}

export function stopPlaybackForDictation(engine: TtsStopTarget = ttsEngine): boolean {
  if (engine.state.state === 'idle') return false;
  engine.stop();
  return true;
}
