import 'server-only';

import {
  buildHttpReplay,
  chunkBase64,
  type HttpReqFrame,
  type RelayHttpRequestRegistry,
} from './relay-connector-protocol';

export interface RelayHttpReplayOptions {
  sid: string;
  request: HttpReqFrame;
  apiBase: string;
  requestRegistry: RelayHttpRequestRegistry;
  timeoutMs: number;
  maxTunnelBytes: number;
  isStreamActive: () => boolean;
  send: (frame: Record<string, unknown>) => void;
  /**
   * Machine web sessions are authenticated by the relay ticket and ownership
   * check, then replayed locally as the desktop operator. Supplying this value
   * replaces any authorization sent by the remote web client.
   */
  authorizationOverride?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Replay the relay's generic HTTP frame into the local gated API. Both relay
 * connectors use this exact request validation, response chunking, timeout, and
 * cancellation path; their authentication handshakes stay separate.
 */
export async function replayRelayHttpRequest(options: RelayHttpReplayOptions): Promise<void> {
  const req = options.request;
  const rid = typeof req.rid === 'string' && req.rid ? req.rid : null;
  if (!rid) return;

  const plan = buildHttpReplay(req, options.apiBase);
  if (!plan.ok) {
    options.send({ t: 'http-res', rid, status: plan.status, error: plan.error, bodyB64: '' });
    return;
  }
  if (options.authorizationOverride) {
    plan.headers.authorization = options.authorizationOverride;
  }

  const controller = options.requestRegistry.begin(options.sid, rid);
  const timeout = setTimeout(() => {
    options.requestRegistry.timeout(options.sid, rid, controller);
  }, options.timeoutMs);
  timeout.unref?.();

  try {
    const response = await (options.fetchImpl ?? fetch)(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (controller.signal.aborted || !options.isStreamActive()) return;
    if (buffer.length > options.maxTunnelBytes) {
      options.send({
        t: 'http-res',
        rid,
        status: 413,
        error: 'tunnel_response_too_large',
        bodyB64: '',
      });
      return;
    }

    const chunks = chunkBase64(buffer.toString('base64'));
    options.send({
      t: 'http-res',
      rid,
      status: response.status,
      headers: subsetResponseHeaders(response.headers),
      bodyB64: chunks[0] ?? '',
      last: chunks.length <= 1,
    });
    for (let index = 1; index < chunks.length; index++) {
      options.send({
        t: 'http-res-part',
        rid,
        i: index,
        last: index === chunks.length - 1,
        bodyB64: chunks[index],
      });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      if (controller.signal.reason === 'timeout' && options.isStreamActive()) {
        options.send({
          t: 'http-res',
          rid,
          status: 504,
          error: 'tunnel_request_timeout',
          bodyB64: '',
        });
      }
      return;
    }
    options.send({
      t: 'http-res',
      rid,
      status: 502,
      error: error instanceof Error ? error.message : String(error),
      bodyB64: '',
    });
  } finally {
    clearTimeout(timeout);
    options.requestRegistry.finish(options.sid, rid, controller);
  }
}

function subsetResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['content-type', 'etag', 'cache-control', 'content-language']) {
    const value = headers.get(key);
    if (value) result[key] = value;
  }
  return result;
}
