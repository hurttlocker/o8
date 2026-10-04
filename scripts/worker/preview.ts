import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PREVIEW_MAX_BYTES, PREVIEW_REQUEST_MS, validPreviewPath, type RemotePreviewRequest, type RemotePreviewResponse } from '../../src/lib/cloud/preview-contract';
import type { CloudWorkerJob, EventStream } from './event-stream';
import type { RunningWorkspaceServices } from './workspace-services';

/** Socket identity, not just a healthy port: every listener must belong to this process group. */
export async function ownsListeningPort(processGroup: number, port: number): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const tables = await Promise.all(['tcp', 'tcp6'].map((name) => readFile(`/proc/net/${name}`, 'utf8')));
    const inodes = new Set<string>();
    for (const table of tables) for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && Number.parseInt(fields[1]!.split(':')[1]!, 16) === port) inodes.add(fields[9]!);
    }
    if (inodes.size === 0) return false;
    for (const pid of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) !== processGroup) continue;
        const directory = `/proc/${pid}/fd`;
        for (const fd of await readdir(directory)) {
          const link = await readlink(path.join(directory, fd)).catch(() => '');
          const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
          if (inode) inodes.delete(inode);
          if (inodes.size === 0) return true;
        }
      } catch { /* A process may exit during the scan; missing ownership fails closed. */ }
    }
    return inodes.size === 0;
  } catch { return false; }
}

async function boundedBody(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return Buffer.concat(parts, length);
      length += result.value.byteLength;
      if (length > PREVIEW_MAX_BYTES) throw new Error('Preview response too large.');
      parts.push(Buffer.from(result.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function readWorkerPreview(job: CloudWorkerJob, services: RunningWorkspaceServices, request: RemotePreviewRequest, signal: AbortSignal): Promise<RemotePreviewResponse> {
  const denied = { id: request.id, status: 503, contentType: 'text/plain; charset=utf-8', body: Buffer.from('The task preview service is unavailable.').toString('base64') };
  if (!request || typeof request.id !== 'string' || !validPreviewPath(request.path)
    || !['GET', 'HEAD'].includes(request.method) || !job.launch.remotePreview
    || JSON.stringify(request.service) !== JSON.stringify(job.launch.remotePreview)) return denied;
  const service = request.service;
  const url = new URL(request.path, `http://127.0.0.1:${service.port}`);
  if (url.origin !== `http://127.0.0.1:${service.port}` || signal.aborted) return denied;
  try {
    if (!await services.ownsPreview(service)) return denied;
    const response = await fetch(url, {
      method: request.method, redirect: 'manual', credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(PREVIEW_REQUEST_MS - 1_000)]),
    });
    if (response.status >= 300 && response.status < 400) return denied;
    const body = await boundedBody(response);
    // Never return bytes if the socket or child was replaced while reading.
    if (signal.aborted || !await services.ownsPreview(service)) return denied;
    return { id: request.id, status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', body: body.toString('base64') };
  } catch { return denied; }
}

export function startPreviewRelay(job: CloudWorkerJob, stream: EventStream, services: RunningWorkspaceServices, signal: AbortSignal) {
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  const done = (async () => {
    while (!active.aborted) {
      try {
        const request = await stream.pollPreview(job, active);
        if (request) await stream.answerPreview(job, await readWorkerPreview(job, services, request, active), active);
      } catch {
        // Preview transport is optional. Lease/abort failure is owned by the job monitor.
        if (!active.aborted) await delay(500, undefined, { signal: active }).catch(() => {});
      }
    }
  })();
  return async () => { controller.abort(); await done; };
}
