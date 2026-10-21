import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { headersIndicateLoopback, isLoopbackHostname, isTauriShellOrigin } from '@/lib/auth/loopback-request';
import { getDeviceManager } from '@/lib/devices/service';
import { DeviceError } from '@/lib/devices/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function authorize(request: Request): string {
  if (resolveRequestPrincipalContext(request).role !== 'operator') throw new DeviceError('device_operator_required', 'Device controls require the local operator.', 403);
  const url = new URL(request.url);
  if (!headersIndicateLoopback((name) => request.headers.get(name)) || !isLoopbackHostname(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new DeviceError('device_local_required', 'Device controls are available only on this computer.', 403);
  }
  // Next may normalize request.url to localhost while the browser uses 127.0.0.1.
  // Bind the page origin to the actual Host, retaining the server port and loopback gate.
  const host = request.headers.get('host') ?? url.host;
  let page: URL;
  try { page = new URL(`${url.protocol}//${host}`); } catch { throw new DeviceError('device_origin_refused', 'Open device controls from this app.', 403); }
  if (!isLoopbackHostname(page.hostname) || page.host !== host || page.port !== url.port || page.username || page.password || page.pathname !== '/' || page.search || page.hash) {
    throw new DeviceError('device_origin_refused', 'Open device controls from this app.', 403);
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== page.origin && !isTauriShellOrigin(origin)) throw new DeviceError('device_origin_refused', 'Open device controls from this app.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site' && !isTauriShellOrigin(origin)) throw new DeviceError('device_origin_refused', 'Open device controls from this app.', 403);
  return origin ?? page.origin;
}

function failure(error: unknown): Response {
  if (error instanceof DeviceError) return json({ error: { code: error.code, message: error.message } }, error.status);
  return json({ error: { code: 'device_request_failed', message: 'Device controls are unavailable. Retry from the panel.' } }, 500);
}

export async function GET(request: Request): Promise<Response> {
  try { authorize(request); return json(await getDeviceManager().state()); } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = authorize(request);
    let body: unknown;
    try {
      if (Number(request.headers.get('content-length') ?? 0) > 1024) throw new Error('Too large');
      const text = await request.text();
      if (text.length > 1024) throw new Error('Too large');
      body = JSON.parse(text);
    } catch { throw new DeviceError('device_action_invalid', 'Choose a valid device panel action.', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DeviceError('device_action_invalid', 'Choose a valid device panel action.', 400);
    const input = body as Record<string, unknown>;
    if (!['install', 'start', 'stop', 'refresh'].includes(String(input.action)) || Object.keys(input).some((key) => key !== 'action' && !(input.action === 'install' && key === 'tool'))) {
      throw new DeviceError('device_action_invalid', 'Choose a valid device panel action.', 400);
    }
    const manager = getDeviceManager();
    if (input.action === 'install') {
      if (input.tool !== undefined && !['hub', 'agent', 'all'].includes(String(input.tool))) throw new DeviceError('device_action_invalid', 'Choose a valid device helper.', 400);
      manager.install((input.tool ?? 'all') as 'hub' | 'agent' | 'all');
    } else if (input.action === 'start') manager.start(origin);
    else if (input.action === 'stop') await manager.stop();
    else await manager.refresh();
    return json(await manager.state(), input.action === 'install' || input.action === 'start' ? 202 : 200);
  } catch (error) { return failure(error); }
}
