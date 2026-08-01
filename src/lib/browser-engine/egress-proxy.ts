import 'server-only';

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { BrowserNetworkPolicyId, BrowserResolvedAddress } from './network-policy';
import { assertBrowserResolvedAddresses } from './network-policy';

export type BrowserProxyResolver = (hostname: string) => Promise<BrowserResolvedAddress[]>;

export interface PinnedBrowserDestination {
  hostname: string;
  address: string;
  family: number;
  port: number;
}

interface BrowserProxyOptions {
  resolver?: BrowserProxyResolver;
}

interface BrowserProxyContextOptions {
  server: string;
  username: BrowserNetworkPolicyId;
  password: string;
}

async function systemResolver(hostname: string): Promise<BrowserResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

/** Resolve once, validate those exact answers, then pass only the chosen IP to the dialer. */
export async function resolveValidateAndDial<T>(
  policy: BrowserNetworkPolicyId,
  hostname: string,
  port: number,
  dial: (destination: PinnedBrowserDestination) => Promise<T> | T,
  resolver: BrowserProxyResolver = systemResolver,
): Promise<T> {
  const normalized = normalizedHostname(hostname);
  if (!normalized) throw new Error('Browser proxy target hostname is missing.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Browser proxy target port is invalid.');
  }

  const literalFamily = isIP(normalized);
  const addresses = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await resolver(normalized);
  assertBrowserResolvedAddresses(policy, normalized, addresses);
  const chosen = addresses[0];
  return dial({ hostname: normalized, address: chosen.address, family: chosen.family, port });
}

function parseAuthority(authority: string, defaultPort: number): { hostname: string; port: number } {
  let target: URL;
  try {
    target = new URL(`http://${authority}`);
  } catch {
    throw new Error('Browser proxy target authority is invalid.');
  }
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Browser proxy target authority is invalid.');
  }
  const port = target.port ? Number(target.port) : defaultPort;
  return { hostname: normalizedHostname(target.hostname), port };
}

function sanitizedHeaders(req: IncomingMessage, host: string): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  return headers;
}

function serializedUpgradeHeaders(req: IncomingMessage, host: string): string {
  const lines: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    if (name.toLowerCase() === 'proxy-authorization' || name.toLowerCase() === 'proxy-connection') continue;
    lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
  }
  if (!lines.some((line) => line.toLowerCase().startsWith('host:'))) lines.push(`Host: ${host}`);
  return lines.join('\r\n');
}

function writeSocketResponse(socket: Duplex, status: number, reason: string, headers: string[] = []): void {
  if (socket.destroyed) return;
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    ...headers,
    'Connection: close',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'));
}

function writeHttpError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
  response.end(message);
}

export class BrowserEgressProxy {
  private readonly server: Server;
  private readonly password = randomBytes(32).toString('base64url');
  private readonly resolver: BrowserProxyResolver;
  private readonly sockets = new Set<Duplex>();
  private port: number | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: BrowserProxyOptions = {}) {
    this.resolver = options.resolver ?? systemResolver;
    this.server = createServer((req, response) => void this.handleHttp(req, response));
    this.server.on('connect', (req, socket, head) => void this.handleConnect(req, socket, head));
    this.server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head));
    this.server.on('connection', (socket) => this.trackSocket(socket));
  }

  async listen(): Promise<this> {
    if (this.port !== null) return this;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Browser egress proxy did not acquire a TCP port.'));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
    return this;
  }

  contextOptions(policy: BrowserNetworkPolicyId): BrowserProxyContextOptions {
    if (this.port === null) throw new Error('Browser egress proxy is not listening.');
    return {
      server: `http://127.0.0.1:${this.port}`,
      username: policy,
      password: this.password,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>((resolve) => {
      for (const socket of this.sockets) socket.destroy();
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    return this.closePromise;
  }

  private trackSocket(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private authenticate(req: IncomingMessage): BrowserNetworkPolicyId | null {
    const authorization = req.headers['proxy-authorization'];
    if (!authorization?.startsWith('Basic ')) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    const username = decoded.slice(0, separator);
    const supplied = Buffer.from(decoded.slice(separator + 1));
    const expected = Buffer.from(this.password);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    return username === 'public' || username === 'capture' ? username : null;
  }

  private async connectPinned(policy: BrowserNetworkPolicyId, hostname: string, port: number): Promise<Socket> {
    return resolveValidateAndDial(policy, hostname, port, (destination) => new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({
        host: destination.address,
        port: destination.port,
        family: destination.family,
      });
      this.trackSocket(socket);
      socket.setTimeout(20_000, () => socket.destroy(new Error('Browser proxy connection timed out.')));
      socket.once('connect', () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.once('error', reject);
    }), this.resolver);
  }

  private async handleConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const policy = this.authenticate(req);
    if (!policy) {
      writeSocketResponse(client, 407, 'Proxy Authentication Required', ['Proxy-Authenticate: Basic realm="o8-browser"']);
      return;
    }
    try {
      const { hostname, port } = parseAuthority(req.url ?? '', 443);
      const upstream = await this.connectPinned(policy, hostname, port);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.once('close', () => upstream.destroy());
      client.once('error', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
    } catch {
      writeSocketResponse(client, 403, 'Forbidden');
    }
  }

  private async handleHttp(req: IncomingMessage, response: ServerResponse): Promise<void> {
    const policy = this.authenticate(req);
    if (!policy) {
      response.setHeader('proxy-authenticate', 'Basic realm="o8-browser"');
      writeHttpError(response, 407, 'Proxy authentication required.');
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error('invalid');
    } catch {
      writeHttpError(response, 400, 'Browser proxy requires an absolute HTTP URL.');
      return;
    }

    try {
      const port = target.port ? Number(target.port) : 80;
      await resolveValidateAndDial(policy, target.hostname, port, (destination) => new Promise<void>((resolve, reject) => {
        const upstream = httpRequest({
          host: destination.address,
          port: destination.port,
          family: destination.family,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: sanitizedHeaders(req, target.host),
        }, (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          upstreamResponse.once('end', resolve);
        });
        upstream.once('socket', (socket) => this.trackSocket(socket));
        upstream.once('error', reject);
        response.once('close', () => upstream.destroy());
        req.pipe(upstream);
      }), this.resolver);
    } catch {
      writeHttpError(response, 403, 'Browser proxy refused the destination.');
    }
  }

  private async handleUpgrade(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const policy = this.authenticate(req);
    if (!policy) {
      writeSocketResponse(client, 407, 'Proxy Authentication Required', ['Proxy-Authenticate: Basic realm="o8-browser"']);
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if ((target.protocol !== 'ws:' && target.protocol !== 'http:') || target.username || target.password) {
        throw new Error('invalid');
      }
    } catch {
      writeSocketResponse(client, 400, 'Bad Request');
      return;
    }

    try {
      const port = target.port ? Number(target.port) : 80;
      const upstream = await this.connectPinned(policy, target.hostname, port);
      const requestTarget = `${target.pathname}${target.search}` || '/';
      const headers = serializedUpgradeHeaders(req, target.host);
      upstream.write(`${req.method ?? 'GET'} ${requestTarget} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      client.once('close', () => upstream.destroy());
      client.once('error', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
    } catch {
      writeSocketResponse(client, 403, 'Forbidden');
    }
  }
}

export async function startBrowserEgressProxy(options: BrowserProxyOptions = {}): Promise<BrowserEgressProxy> {
  return new BrowserEgressProxy(options).listen();
}
