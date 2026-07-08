#!/usr/bin/env node
// STT latency harness (#1494) — measures batch transcription p50/p95 for the
// paid-proxy provider decision. Run from the machine that will actually make
// the calls in production (the Railway proxy box for the real decision; local
// runs are directional only — say which in the report).
//
// Usage:
//   GROQ_API_KEY=... DEEPGRAM_API_KEY=... CF_ACCOUNT_ID=... CF_API_TOKEN=... \
//   ELEVENLABS_API_KEY=... node scripts/stt-latency-harness.mjs <clip.wav> [runs=5]
//
// Providers are skipped silently when their env keys are absent. Output: one
// table row per provider — p50/p95/min/max ms + the transcript from the last
// run (eyeball accuracy; the reference text is whatever you dictated).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const clip = process.argv[2];
const runs = Number(process.argv[3] || 5);
if (!clip) {
  console.error('usage: node scripts/stt-latency-harness.mjs <clip.wav> [runs]');
  process.exit(1);
}
const audio = readFileSync(clip);

function quantile(sorted, q) {
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function timeIt(fn) {
  const t0 = performance.now();
  const text = await fn();
  return { ms: Math.round(performance.now() - t0), text };
}

function multipart(fields, fileField, fileName, fileBytes) {
  const boundary = `----o8harness${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(fileBytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const providers = [];

if (process.env.GROQ_API_KEY) {
  providers.push({
    name: 'groq whisper-large-v3-turbo',
    run: async () => {
      const { body, contentType } = multipart(
        { model: 'whisper-large-v3-turbo', temperature: '0', response_format: 'json' },
        'file', basename(clip), audio,
      );
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': contentType },
        body,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json).slice(0, 120));
      return json.text ?? '';
    },
  });
}

if (process.env.DEEPGRAM_API_KEY) {
  providers.push({
    name: 'deepgram nova-3',
    run: async () => {
      const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true', {
        method: 'POST',
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
        body: audio,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json).slice(0, 120));
      return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    },
  });
}

if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) {
  providers.push({
    name: 'cloudflare whisper-large-v3-turbo',
    run: async () => {
      // whisper-large-v3-turbo on Workers AI takes JSON {audio: <base64>}
      // (the older @cf/openai/whisper takes raw bytes — different contract).
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/openai/whisper-large-v3-turbo`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: audio.toString('base64') }),
        },
      );
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(JSON.stringify(json.errors ?? json).slice(0, 120));
      return json.result?.text ?? '';
    },
  });
}

if (process.env.ELEVENLABS_API_KEY) {
  providers.push({
    name: 'elevenlabs scribe-v1',
    run: async () => {
      const { body, contentType } = multipart(
        { model_id: 'scribe_v1' },
        'file', basename(clip), audio,
      );
      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': contentType },
        body,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json).slice(0, 120));
      return json.text ?? '';
    },
  });
}

if (providers.length === 0) {
  console.error('no provider keys in env — set GROQ_API_KEY / DEEPGRAM_API_KEY / CF_ACCOUNT_ID+CF_API_TOKEN / ELEVENLABS_API_KEY');
  process.exit(1);
}

console.log(`clip: ${clip} (${(audio.length / 1024).toFixed(0)}KB) · ${runs} runs each\n`);
for (const provider of providers) {
  const times = [];
  let lastText = '';
  let error = null;
  for (let i = 0; i < runs; i += 1) {
    try {
      const { ms, text } = await timeIt(provider.run);
      times.push(ms);
      lastText = text;
    } catch (e) {
      error = e.message;
    }
  }
  if (times.length === 0) {
    console.log(`${provider.name}: ALL RUNS FAILED — ${error}`);
    continue;
  }
  times.sort((a, b) => a - b);
  console.log(
    `${provider.name}: p50 ${quantile(times, 0.5)}ms · p95 ${quantile(times, 0.95)}ms · min ${times[0]} · max ${times[times.length - 1]} (${times.length}/${runs} ok)`,
  );
  console.log(`  → "${lastText.trim().slice(0, 110)}"\n`);
}
