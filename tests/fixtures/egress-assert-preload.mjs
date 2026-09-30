import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const INSTALL_KEY = Symbol.for('o8.egress-assert-preload.installed');

function isLoopback(host) {
  const normalized = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.');
}

function normalizedTarget(host, port) {
  const numericPort = Number(port);
  if (!host || !Number.isFinite(numericPort)) return null;
  const normalizedHost = String(host).replace(/^\[|\]$/g, '');
  return {
    host: normalizedHost,
    port: numericPort,
    endpoint: `${normalizedHost}:${numericPort}`,
  };
}

function socketTarget(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    return normalizedTarget(first.host ?? first.hostname ?? 'localhost', first.port);
  }
  if (typeof first === 'number') {
    return normalizedTarget(typeof args[1] === 'string' ? args[1] : 'localhost', first);
  }
  return null; // Unix-domain / named-pipe connection: machine-local, not egress.
}

function urlTarget(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL
      ? input
      : input && typeof input === 'object' && typeof input.url === 'string'
        ? input.url
        : null;
    if (!raw) return null;
    const parsed = raw instanceof URL ? raw : new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return null;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === 'https:' || parsed.protocol === 'wss:'
        ? 443
        : 80;
    return normalizedTarget(parsed.hostname, port);
  } catch {
    return null;
  }
}

function httpTarget(protocol, args) {
  const direct = urlTarget(args[0]);
  if (direct) return direct;
  const options = args[0];
  if (!options || typeof options !== 'object') return null;
  const defaultPort = protocol === 'https:' ? 443 : 80;
  return normalizedTarget(options.hostname ?? options.host ?? 'localhost', options.port ?? defaultPort);
}

function surfaceFromStack() {
  const explicit = process.env.O8_EGRESS_SURFACE?.trim();
  if (explicit) return explicit;

  const stack = new Error().stack ?? '';
  if (/cortex[\\/]qa[\\/]llm/i.test(stack)) return 'Brain';
  if (/[\\/](?:telemetry|analytics)[\\/]/i.test(stack)) return 'telemetry';
  if (/[\\/](?:updater|update)[\\/]/i.test(stack)) return 'updater';
  if (/[\\/]runtimes[\\/]/i.test(stack)) return 'runtime-adapter';
  if (/[\\/](?:orchestrator|lane)[\\/]/i.test(stack)) return 'dispatch';
  return 'o8-server';
}

function configuredAllowedEndpoints() {
  return new Set(
    (process.env.O8_EGRESS_ALLOWED_ENDPOINTS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function record(target, transport) {
  const reportPath = process.env.O8_EGRESS_REPORT_PATH?.trim();
  if (!reportPath || !target) return;

  const allowed = configuredAllowedEndpoints();
  const endpoint = target.endpoint.toLowerCase();
  const providerEndpoint = allowed.has(endpoint);
  const loopbackInfrastructure = isLoopback(target.host) && !providerEndpoint;

  // Local o8 IPC is not machine egress. The configured local-provider endpoint
  // is retained even when it is loopback so the report proves Brain/worker use.
  if (loopbackInfrastructure) return;

  const row = {
    at: new Date().toISOString(),
    pid: process.pid,
    surface: surfaceFromStack(),
    transport,
    host: target.host,
    port: target.port,
    endpoint: target.endpoint,
    allowed: providerEndpoint,
  };
  appendFileSync(reportPath, `${JSON.stringify(row)}\n`, 'utf8');

  if (!providerEndpoint && process.env.O8_EGRESS_BLOCK_UNEXPECTED === '1') {
    throw new Error(
      `O8_EGRESS_BLOCKED surface=${row.surface} transport=${transport} endpoint=${row.endpoint}; `
      + 'the attempted destination was recorded before connect',
    );
  }
}

function patchHttpModule(module, protocol) {
  const originalRequest = module.request;
  module.request = function o8EgressRecordedRequest(...args) {
    record(httpTarget(protocol, args), protocol === 'https:' ? 'https' : 'http');
    return Reflect.apply(originalRequest, this, args);
  };
  const originalGet = module.get;
  module.get = function o8EgressRecordedGet(...args) {
    record(httpTarget(protocol, args), protocol === 'https:' ? 'https' : 'http');
    return Reflect.apply(originalGet, this, args);
  };
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  process.env.O8_EGRESS_PRELOAD_PID = String(process.pid);

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function o8EgressRecordedFetch(input, init) {
      record(urlTarget(input), 'fetch');
      return Reflect.apply(originalFetch, this, [input, init]);
    };
  }

  if (typeof globalThis.WebSocket === 'function') {
    const OriginalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        record(urlTarget(args[0]), 'websocket');
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  patchHttpModule(http, 'http:');
  patchHttpModule(https, 'https:');

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function o8EgressRecordedConnect(...args) {
    const target = socketTarget(args);
    // Raw TCP is still important for clients that bypass fetch/http. The
    // higher-level hooks above are request-counted; raw TCP may add a second
    // row for such libraries, which is intentional evidence rather than a miss.
    if (target) record(target, 'tcp');
    return Reflect.apply(originalConnect, this, args);
  };
}
