import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { apnsConfigured, sendApprovalAlert } from './apns.js';
import { attachRelayUpgrade, type UpgradableServer } from './attach.js';
import { relayOffNetwork } from './entitlement.js';
import { env } from './env.js';
import { createLicenseServerClient } from './license-client.js';
import { verifyMachineRelayTicketWith } from './machine-ticket.js';
import { verifyPlanTokenWith } from './plan-jwt.js';
import { RelayServer } from './relay.js';

/**
 * o8 relay entrypoint. Hono serves a stateless `/health` (same ops story as
 * license-server); ws upgrades are routed by path to the relay concentrator.
 * This is the ONE place env is loaded — the relay + verifier are otherwise
 * env-free so they unit-test with fakes.
 */

const licenseClient = createLicenseServerClient({
  baseUrl: env.LICENSE_SERVER_BASE_URL,
});

const relay = new RelayServer({
  // Bind the pure verifier to the configured public key + issuer.
  verifyPlanToken: (token) =>
    verifyPlanTokenWith(token, { publicKeyPem: env.LICENSE_PUBLIC_KEY, issuer: env.ISSUER }),
  relayOffNetwork,
  verifyMachineTicket: (token) => verifyMachineRelayTicketWith(token, {
    publicKeyPem: env.LICENSE_PUBLIC_KEY,
    issuer: env.ISSUER,
  }),
  authorizeWebMachine: licenseClient.authorizeWebMachine,
  heartbeatMachine: licenseClient.heartbeatMachine,
  sendApprovalAlert,
  apnsConfigured,
});
relay.start();

const app = new Hono();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'o8-relay',
    issuer: env.ISSUER,
    apns: apnsConfigured() ? 'configured' : 'disabled',
    ...relay.stats(),
  }),
);
app.all('*', (c) => c.json({ error: 'not_found' }, 404));

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[relay] listening on :${info.port} (issuer=${env.ISSUER}, apns=${apnsConfigured() ? 'on' : 'off'})`);
});

// @hono/node-server returns the underlying node http server (has .on('upgrade')).
attachRelayUpgrade(server as unknown as UpgradableServer, relay);

function shutdown(signal: string): void {
  console.log(`[relay] ${signal} — shutting down`);
  relay.stop();
  try {
    (server as unknown as { close: (cb?: () => void) => void }).close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, relay };
