import { appendFileSync } from 'node:fs';
import net from 'node:net';

const INSTALL_KEY = Symbol.for('o8.egress-assert-preload.installed');

function isLoopback(host) {
  const normalized = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('127.');
}

function endpointOf(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    const port = Number(first.port);
    if (!Number.isFinite(port)) return null;
    const host = String(first.host ?? first.hostname ?? 'localhost');
    return { host, port, endpoint: `${host}:${port}` };
  }
  if (typeof first === 'number') {
    const port = first;
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    return { host, port, endpoint: `${host}:${port}` };
  }
  return null; // Unix-domain / named-pipe connection: machine-local, not egress.
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

function record(target) {
  const reportPath = process.env.O8_EGRESS_REPORT_PATH?.trim();
  if (!reportPath) return;

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
    host: target.host,
    port: target.port,
    endpoint: target.endpoint,
    allowed: providerEndpoint,
  };
  appendFileSync(reportPath, `${JSON.stringify(row)}\n`, 'utf8');

  if (!providerEndpoint && process.env.O8_EGRESS_BLOCK_UNEXPECTED === '1') {
    throw new Error(
      `O8_EGRESS_BLOCKED surface=${row.surface} endpoint=${row.endpoint}; `
      + 'the attempted destination was recorded before connect',
    );
  }
}

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function o8EgressRecordedConnect(...args) {
    const target = endpointOf(args);
    if (target) record(target);
    return Reflect.apply(originalConnect, this, args);
  };
}
