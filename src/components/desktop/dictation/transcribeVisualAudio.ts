import { canUseTauriEvents } from '@/lib/tauri/bridge';
import type { TimedDictationWord } from './types';

export async function transcribeVisualAudio(id: string, audio: Blob): Promise<{ text: string; words: TimedDictationWord[] } | null> {
  if (!canUseTauriEvents() || audio.size > 10_000_000) return null;
  try {
    const dataUri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(audio); });
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ text?: unknown; words?: unknown }>('o8_visual_capture_transcribe_audio', { id, audio: dataUri.slice(dataUri.indexOf(',') + 1), mime: audio.type.split(';')[0] });
    if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 8_000 || !Array.isArray(result.words) || !result.words.length || result.words.length > 8_000) return null;
    const words: TimedDictationWord[] = [];
    for (const word of result.words) {
      if (!word || typeof word !== 'object' || typeof word.text !== 'string' || !word.text.trim() || word.text.length > 500
        || typeof word.t0 !== 'number' || !Number.isFinite(word.t0) || typeof word.t1 !== 'number' || !Number.isFinite(word.t1)
        || word.t0 < 0 || word.t1 < word.t0 || word.t1 > 90_000 || words.length && word.t0 < words[words.length - 1].t0) return null;
      words.push({ t0: word.t0, t1: word.t1, text: word.text });
    }
    return { text: result.text, words };
  } catch { return null; }
}
