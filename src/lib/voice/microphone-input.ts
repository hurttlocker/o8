import { isTauri } from '@/lib/tauri/bridge';

export interface MicrophoneInput { stream: MediaStream; stop: (captureEnded?: Promise<void>) => Promise<void> }
const owners = new WeakMap<object, string>();
const busy = 'Another voice input is active. Finish it before starting another microphone.';

/** Reserve before permission; a cancelled, unresolved permission request retains its claim. */
export async function captureMicrophone(constraints: MediaStreamConstraints, current: () => boolean = () => true): Promise<MicrophoneInput> {
  const surface = typeof window === 'undefined' ? globalThis : window;
  if (owners.has(surface)) throw new Error(busy);
  const token = crypto.randomUUID(); owners.set(surface, token);
  let native = false;
  let stopping: Promise<void> | undefined;
  let stream: MediaStream | undefined;
  const stop = (captureEnded?: Promise<void>): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      stream?.getTracks().forEach(track => track.stop());
      await captureEnded;
      if (native) await (await import('@tauri-apps/api/core')).invoke('voice_input_release', { owner: token });
      if (owners.get(surface) === token) owners.delete(surface);
    })();
    return stopping;
  };
  try {
    if (isTauri()) {
      await (await import('@tauri-apps/api/core')).invoke('voice_input_claim', { owner: token });
      native = true;
    }
    if (!current()) throw new Error('Microphone startup was cancelled.');
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!current()) throw new Error('Microphone startup was cancelled.');
    return { stream, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
