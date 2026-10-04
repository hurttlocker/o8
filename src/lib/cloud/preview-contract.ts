import { createHash } from 'node:crypto';
import type { WorkspaceManifest } from '@/lib/workspace/manifest/types';

export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const PREVIEW_REQUEST_MS = 8_000;

export interface RemotePreviewService {
  name: string;
  commandId: string;
  port: number;
  path: string;
}

export interface RemotePreviewRequest {
  id: string;
  service: RemotePreviewService;
  path: string;
  method: 'GET' | 'HEAD';
}

export interface RemotePreviewResponse {
  id: string;
  status: number;
  contentType: string;
  body: string;
}

/** No arbitrary destinations: preview must resolve one reviewed service port. */
export function remotePreviewService(manifest: WorkspaceManifest): RemotePreviewService | undefined {
  if (!manifest.preview) return undefined;
  let value = manifest.preview.url;
  const services = manifest.services ?? [];
  for (const service of services) {
    value = value.replaceAll(`{{service:${service.name}}}`, String(service.port?.preferred ?? ''));
  }
  value = value.replaceAll('{{port}}', String(services[0]?.port?.preferred ?? ''));
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.hash || value.includes('{{')) {
    throw new Error('Remote preview must target one reviewed HTTP service on loopback.');
  }
  const port = Number(url.port || 80);
  const candidates = services.filter((service) => service.port?.preferred === port && service.health);
  if (candidates.length !== 1) throw new Error('Remote preview must identify exactly one health-checked workspace service.');
  const service = candidates[0]!;
  return { name: service.name, commandId: createHash('sha256').update(service.command).digest('hex'), port, path: url.pathname + url.search };
}

export function validPreviewPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4_096 || !value.startsWith('/') || value.startsWith('//')
    || /[\\\x00-\x20\x7f#]/.test(value)) return false;
  const url = new URL(value, 'http://127.0.0.1');
  return url.origin === 'http://127.0.0.1';
}
