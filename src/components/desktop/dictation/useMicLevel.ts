import { useEffect, useRef } from 'react';

/** Measured Web Audio fallback for legacy dock-owned sessions. Capture is
 * released when the dock returns to idle or another surface owns dictation. */

export function useMicLevel(
  active: boolean,
  onLevel: (level: number) => void,
  onError?: (msg: string) => void,
): void {
  const onLevelRef = useRef(onLevel);
  const onErrorRef = useRef(onError);
  useEffect(() => { onLevelRef.current = onLevel; }, [onLevel]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    if (!active) { onLevelRef.current(0); return; }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return;
    }
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let disposed = false;
    let last = 0;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (disposed) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AC();
        // WebKit starts the context SUSPENDED without a user gesture → the
        // analyser reads silence. Resume so it actually processes the mic.
        void ctx.resume();
        const source = ctx.createMediaStreamSource(s);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = (now: number) => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          // Speech RMS is TINY (~0.005–0.03 at normal talking volume). Subtract a
          // small noise floor so silence reads flat, then apply a high-gain sqrt
          // curve so NORMAL talking (not yelling) drives a strong waveform + glow.
          const adj = Math.max(0, rms - 0.003);
          const level = Math.min(1, Math.sqrt(adj * 34));
          if (now - last > 32) { // ~30fps into React — smooth, no re-render thrash
            last = now;
            onLevelRef.current(level);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((err) => {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        onErrorRef.current?.(`mic-level getUserMedia failed: ${msg}`);
      });
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (ctx) { try { void ctx.close(); } catch { /* noop */ } }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      onLevelRef.current(0);
    };
  }, [active]);
}

