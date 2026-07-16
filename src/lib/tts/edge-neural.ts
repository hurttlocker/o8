import 'server-only';

/**
 * Native Node client for Microsoft Edge's free neural TTS (the read-aloud
 * voice service) — NO Python, NO pip, NO machine deps beyond the `ws` package
 * the ws-server already ships.
 *
 * Why this exists: /api/tts used to shell out to the `edge-tts` Python CLI,
 * which only exists where someone pip-installed it. The boot-time auto-install
 * (ensure-edge-tts.ts) was the band-aid after Sydney's laptop; Q's dogfood
 * laptop proved the band-aid doesn't hold (report S9KT8H, 2026-07-16 — Steffan
 * silently failed and the Rust `say` floor picked Fred, the "Stephen Hawking"
 * voice). A fresh machine must get the real voice with ZERO setup.
 *
 * Protocol (same one the Python tool speaks): wss to the consumer read-aloud
 * endpoint with the public TrustedClientToken + a Sec-MS-GEC clock hash, send
 * a speech.config frame + an SSML frame, collect binary audio frames (payload
 * after the 2-byte-length header) until the turn.end text frame.
 */

import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/** Public token the Edge browser itself uses for read-aloud (same one inside
 *  the Python edge-tts package). Not a secret. */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// Keep in sync with the edge-tts Python package's CHROMIUM_FULL_VERSION —
// the endpoint 403s stale versions (live-hit 2026-07-16 with a 130.x string).
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SYNTH_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const SYNTH_TIMEOUT_MS = 30_000;

/** Sec-MS-GEC: SHA-256 of (windows-file-time rounded down to 5 min) + token,
 *  uppercase hex — the endpoint rejects connections without it. */
function generateSecMsGec(now: number = Date.now()): string {
  let ticks = Math.floor(now / 1000) + 11_644_473_600; // Windows epoch, seconds
  ticks -= ticks % 300; // round down to 5 minutes
  const fileTime = `${ticks}0000000`; // seconds → 100ns ticks, exact (no float)
  return createHash('sha256')
    .update(`${fileTime}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ssml(text: string, voice: string): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
    + `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>`
    + `${escapeXml(text)}</prosody></voice></speak>`;
}

/** Synthesize `text` with an Edge neural voice → MP3 buffer. Rejects on any
 *  protocol/network failure so callers can fall through to their next tier. */
export function synthesizeEdgeNeural(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const connectionId = randomUUID().replace(/-/g, '');
    const url = `${SYNTH_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${generateSecMsGec()}`
      + `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`
      + `&ConnectionId=${connectionId}`;

    const socket = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          + ` (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36`
          + ` Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0`,
      },
      handshakeTimeout: 10_000,
    });

    const audioChunks: Buffer[] = [];
    let settled = false;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closing */ }
      if (error) reject(error);
      else if (audioChunks.length === 0) reject(new Error('edge-neural: no audio frames received'));
      else resolve(Buffer.concat(audioChunks));
    };

    const timer = setTimeout(() => finish(new Error('edge-neural: synthesis timed out')), SYNTH_TIMEOUT_MS);

    socket.on('open', () => {
      const timestamp = new Date().toString();
      socket.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        }),
      );
      socket.send(
        `X-RequestId:${connectionId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n`
        + ssml(text, voice),
      );
    });

    socket.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buffer.length < 2) return;
        const headerLength = buffer.readUInt16BE(0);
        const header = buffer.subarray(2, 2 + headerLength).toString('utf8');
        if (header.includes('Path:audio')) {
          const payload = buffer.subarray(2 + headerLength);
          if (payload.length > 0) audioChunks.push(payload);
        }
        return;
      }
      const message = data.toString();
      if (message.includes('Path:turn.end')) finish(null);
    });

    socket.on('error', (error) => finish(new Error(`edge-neural: ${error.message}`)));
    socket.on('close', () => finish(new Error('edge-neural: socket closed before turn.end')));
  });
}
