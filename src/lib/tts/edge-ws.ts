/**
 * Edge TTS WebSocket Client — browser-direct, no server needed.
 *
 * Connects to Microsoft's public TTS WebSocket endpoint (same one Edge browser uses).
 * Sends SSML, receives streaming audio chunks, returns a playable Blob URL.
 *
 * Voice: en-US-SteffanNeural (Mister's canonical voice)
 * Cost: Free (public endpoint)
 * Latency: ~200-400ms to first chunk
 */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

function generateId(): string {
  // 32 hex chars, no dashes
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function dateToString(): string {
  return new Date().toUTCString();
}

function buildConfigPayload(): string {
  return JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: 'false',
            wordBoundaryEnabled: 'true',
          },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  });
}

function buildSSML(text: string, voice: string, rate: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    escaped +
    `</prosody></voice></speak>`
  );
}

export interface EdgeTTSOptions {
  voice?: string;
  rate?: string;
}

/**
 * Synthesize text to audio via Edge TTS WebSocket.
 * Returns a Blob URL playable with HTMLAudioElement.
 */
export async function synthesize(
  text: string,
  options: EdgeTTSOptions = {},
): Promise<string> {
  const { voice = 'en-US-SteffanNeural', rate = '+0%' } = options;

  return new Promise<string>((resolve, reject) => {
    const requestId = generateId();
    const connectionId = generateId();
    const audioChunks: ArrayBuffer[] = [];
    let resolved = false;

    const url =
      `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
      `?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&ConnectionId=${connectionId}`;

    let ws: WebSocket;
    try {
      console.log('[EdgeTTS] Creating WebSocket to:', url.substring(0, 80) + '...');
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[EdgeTTS] WebSocket constructor failed:', err);
      reject(new Error(`Edge TTS: failed to create WebSocket: ${err}`));
      return;
    }

    // Receive binary data as ArrayBuffer (not Blob)
    ws.binaryType = 'arraybuffer';
    console.log('[EdgeTTS] WebSocket created, binaryType=arraybuffer, waiting for open...');

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.error('[EdgeTTS] TIMEOUT after 12s. readyState:', ws.readyState);
        try { ws.close(); } catch {}
        reject(new Error('Edge TTS: timeout (12s)'));
      }
    }, 12_000);

    const finish = () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch {}
        if (audioChunks.length > 0) {
          console.log(`[EdgeTTS] SUCCESS: ${audioChunks.length} chunks, building blob`);
          const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
          console.log(`[EdgeTTS] Blob size: ${blob.size} bytes`);
          resolve(URL.createObjectURL(blob));
        } else {
          console.error('[EdgeTTS] FAILED: connection closed with 0 audio chunks');
          reject(new Error('Edge TTS: no audio received'));
        }
      }
    };

    ws.onopen = () => {
      console.log('[EdgeTTS] WebSocket OPEN. Sending config + SSML...');

      // 1. Send speech config
      const configMsg =
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        buildConfigPayload();
      ws.send(configMsg);
      console.log('[EdgeTTS] Config sent');

      // 2. Send SSML synthesis request
      const ssmlMsg =
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${dateToString()}\r\n` +
        `Path:ssml\r\n\r\n` +
        buildSSML(text, voice, rate);
      ws.send(ssmlMsg);
      console.log('[EdgeTTS] SSML sent, voice:', voice, 'text length:', text.length);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        const preview = event.data.substring(0, 120);
        console.log('[EdgeTTS] Text message:', preview);
        if (event.data.includes('Path:turn.end')) {
          console.log('[EdgeTTS] Got turn.end — finishing');
          finish();
        }
      } else if (event.data instanceof ArrayBuffer) {
        const buf = event.data as ArrayBuffer;
        if (buf.byteLength < 2) {
          console.log('[EdgeTTS] Binary message too small:', buf.byteLength);
          return;
        }

        const view = new DataView(buf);
        // First 2 bytes = header length (big-endian uint16)
        const headerLen = view.getUint16(0);
        const audioStart = 2 + headerLen;

        if (audioStart < buf.byteLength) {
          const audioSlice = buf.slice(audioStart);
          audioChunks.push(audioSlice);
          if (audioChunks.length <= 3) {
            console.log(`[EdgeTTS] Audio chunk #${audioChunks.length}: headerLen=${headerLen}, audioBytes=${audioSlice.byteLength}`);
          }
        } else {
          console.log(`[EdgeTTS] Binary frame: headerLen=${headerLen} >= bufLen=${buf.byteLength}, no audio`);
        }
      } else {
        console.log('[EdgeTTS] Unknown message type:', typeof event.data, event.data);
      }
    };

    ws.onerror = (ev) => {
      console.error('[EdgeTTS] WebSocket ERROR:', ev);
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error('Edge TTS: WebSocket error'));
      }
    };

    ws.onclose = (ev) => {
      console.log('[EdgeTTS] WebSocket CLOSED. code:', ev.code, 'reason:', ev.reason, 'wasClean:', ev.wasClean);
      finish();
    };
  });
}
