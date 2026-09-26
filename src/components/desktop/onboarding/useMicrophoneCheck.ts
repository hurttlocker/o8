import { useEffect, useRef, useState } from 'react';

export function useMicrophoneCheck() {
  const [state, setState] = useState<'idle' | 'starting' | 'listening' | 'heard' | 'silent' | 'interrupted' | 'error'>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const resources = useRef<{ stream: MediaStream; context: AudioContext; timer?: ReturnType<typeof setInterval>; deadline?: ReturnType<typeof setTimeout> } | null>(null);
  const cleanup = () => {
    generation.current += 1;
    const current = resources.current;
    resources.current = null;
    if (!current) return;
    clearInterval(current.timer);
    clearTimeout(current.deadline);
    current.stream.getTracks().forEach((track) => track.stop());
    void current.context.close().catch(() => {});
  };
  useEffect(() => {
    const interrupt = () => {
      if (!resources.current) return;
      cleanup(); setLevel(0); setState('interrupted');
    };
    const visibility = () => { if (document.hidden) interrupt(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', interrupt);
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', interrupt); cleanup(); };
  }, []);
  const stop = () => { cleanup(); setLevel(0); setState('idle'); };
  const start = async () => {
    cleanup();
    const run = generation.current;
    setState('starting'); setError('');
    let stream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') throw new Error('Microphone testing is unavailable here. Use the desktop app.');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      const context = new AudioContext();
      resources.current = { stream, context };
      await context.resume();
      if (run !== generation.current) return;
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let heard = false;
      const endsAt = Date.now() + 8000;
      const finish = () => {
        if (run !== generation.current) return;
        cleanup(); setLevel(0); setState(heard ? 'heard' : 'silent');
      };
      setState('listening');
      if (!resources.current) return;
      resources.current.timer = setInterval(() => {
        if (Date.now() >= endsAt) { finish(); return; }
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
        heard ||= rms > 0.008;
        setLevel(Math.min(1, rms * 6));
      }, 100);
      resources.current.deadline = setTimeout(finish, 8000);
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      if (run !== generation.current) return;
      cleanup(); setLevel(0); setState('error');
      setError(Boolean(cause && typeof cause === 'object' && 'name' in cause && cause.name === 'NotAllowedError')
        ? 'Microphone access was not granted. Allow it in System Settings, then try again.'
        : cause instanceof Error ? cause.message : 'Could not open the microphone. Try again.');
    }
  };
  return { state, level, error, start, stop, busy: state === 'starting' || state === 'listening' };
}
