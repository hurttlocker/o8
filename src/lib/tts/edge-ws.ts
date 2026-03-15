/**
 * Edge TTS WebSocket Client — browser-direct, no server needed.
 *
 * Connects to Microsoft's public TTS WebSocket endpoint (same one Edge browser uses).
 * Sends SSML, receives streaming audio chunks, returns a playable Blob.
 *
 * Voice: en-US-SteffanNeural (Mister's canonical voice)
 * Cost: Free (public endpoint)
 * Latency: ~200-400ms to first chunk
 */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}`;
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3';

function generateRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function buildConfigMessage(requestId: string): string {
  return [
    `X-Timestamp:${new Date().toISOString()}`,
    'Content-Type:application/json; charset=utf-8',
    `Path:speech.config`,
    '',
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
            outputFormat: OUTPUT_FORMAT,
          },
        },
      },
    }),
  ].join('\r\n');
}

function buildSSMLMessage(requestId: string, text: string, voice: string, rate: string): string {
  // Escape XML special characters
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    escaped +
    `</prosody></voice></speak>`;

  return [
    `X-RequestId:${requestId}`,
    `Content-Type:application/ssml+xml`,
    `X-Timestamp:${new Date().toISOString()}`,
    `Path:ssml`,
    '',
    ssml,
  ].join('\r\n');
}

export interface EdgeTTSOptions {
  voice?: string;
  rate?: string;
  onChunk?: (chunk: ArrayBuffer) => void;
  onWordBoundary?: (offset: number, text: string) => void;
}

/**
 * Synthesize text to MP3 audio via Microsoft's Edge TTS WebSocket.
 * Returns a Blob URL that can be played with HTMLAudioElement.
 */
export async function synthesize(
  text: string,
  options: EdgeTTSOptions = {},
): Promise<string> {
  const {
    voice = 'en-US-SteffanNeural',
    rate = '+0%',
    onChunk,
    onWordBoundary,
  } = options;

  return new Promise<string>((resolve, reject) => {
    const requestId = generateRequestId();
    const audioChunks: ArrayBuffer[] = [];
    let resolved = false;

    const ws = new WebSocket(WSS_URL);

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('Edge TTS: connection timeout (10s)'));
      }
    }, 10_000);

    ws.onopen = () => {
      // Send config
      ws.send(buildConfigMessage(requestId));
      // Send SSML
      ws.send(buildSSMLMessage(requestId, text, voice, rate));
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Text message — check for turn.end or word boundaries
        if (event.data.includes('Path:turn.end')) {
          // Synthesis complete — build blob
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            ws.close();
            const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            resolve(url);
          }
        } else if (event.data.includes('Path:audio.metadata') && onWordBoundary) {
          // Parse word boundary metadata
          try {
            const jsonStart = event.data.indexOf('{');
            if (jsonStart >= 0) {
              const json = JSON.parse(event.data.slice(jsonStart));
              const items = json?.Metadata ?? [];
              for (const item of items) {
                if (item.Type === 'WordBoundary') {
                  onWordBoundary(
                    item.Data?.Offset ?? 0,
                    item.Data?.text?.Text ?? '',
                  );
                }
              }
            }
          } catch {
            // Ignore parse errors in metadata
          }
        }
      } else if (event.data instanceof Blob) {
        // Binary message — audio chunk
        event.data.arrayBuffer().then((buf) => {
          // Strip the header (everything before "Path:audio\r\n")
          const headerEnd = findAudioHeader(buf);
          const audioData = headerEnd >= 0 ? buf.slice(headerEnd) : buf;
          if (audioData.byteLength > 0) {
            audioChunks.push(audioData);
            onChunk?.(audioData);
          }
        });
      }
    };

    ws.onerror = (event) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error('Edge TTS: WebSocket error'));
      }
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        if (audioChunks.length > 0) {
          const blob = new Blob(audioChunks, { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          resolve(url);
        } else {
          reject(new Error('Edge TTS: connection closed with no audio'));
        }
      }
    };
  });
}

/**
 * Find the end of the binary message header.
 * Edge TTS binary messages have a text header ending with "Path:audio\r\n"
 * followed by a 2-byte separator, then the actual audio data.
 */
function findAudioHeader(buffer: ArrayBuffer): number {
  const view = new Uint8Array(buffer);
  // Look for the pattern: "Path:audio\r\n" in ASCII
  const needle = [0x50, 0x61, 0x74, 0x68, 0x3A, 0x61, 0x75, 0x64, 0x69, 0x6F, 0x0D, 0x0A];
  for (let i = 0; i <= view.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (view[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return i + needle.length;
    }
  }
  return -1;
}
