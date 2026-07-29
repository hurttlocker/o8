import type { Context, Hono } from 'hono';

export type MachinePlan = 'free' | 'pro' | 'team';

export const DEVICE_CAPS: Readonly<Record<MachinePlan, number>> = {
  free: 3,
  pro: 10,
  team: 25,
};

export const HEARTBEAT_CADENCE_SECONDS = 60;
export const OFFLINE_AFTER_SECONDS = 180;
export const RELAY_TICKET_TTL_SECONDS = 10 * 60;

export interface MachineDevice {
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface MachinePrincipal {
  accountId: string;
  plan: MachinePlan;
}

export type MachineAuthResult =
  | { ok: true; principal: MachinePrincipal }
  | {
    ok: false;
    status: 401 | 403;
    reason: 'unauthorized' | 'account_link_required';
  };

export interface MachineRegistration {
  accountId: string;
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  deviceCap: number;
  now: Date;
}

export type MachineRegistrationResult =
  | { ok: true; machineId: string; devices: MachineDevice[] }
  | { ok: false; devices: MachineDevice[] };

/**
 * registerAtomically is the load-bearing seam: implementations must make the
 * existing-install check, active count, cap decision, and insert/reactivation
 * one serialized transaction for the account.
 */
export interface MachineStore {
  registerAtomically(input: MachineRegistration): Promise<MachineRegistrationResult>;
  list(accountId: string): Promise<MachineDevice[]>;
  disconnect(accountId: string, machineId: string, now: Date): Promise<void>;
  heartbeat(accountId: string, machineId: string, now: Date): Promise<boolean>;
}

export interface MachineRouteDependencies {
  authenticate(token: string | null): Promise<MachineAuthResult>;
  store: MachineStore;
  now(): Date;
  newMachineId(): string;
  relayTickets?: {
    mint(input: {
      accountId: string;
      machine: MachineDevice;
      now: Date;
    }): Promise<{ ticket: string; expiresAt: number }>;
    authorizeHeartbeat(
      token: string | null,
      machineId: string,
    ): Promise<
      | { ok: true; accountId: string }
      | {
        ok: false;
        status: 401 | 403;
        reason: 'unauthorized' | 'account_link_required';
      }
    >;
  };
}

interface RegisterBody {
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
}

function bearerToken(c: Context): string | null {
  const authorization = c.req.header('authorization');
  if (!authorization || !/^Bearer\s+/i.test(authorization)) return null;
  return authorization.replace(/^Bearer\s+/i, '').trim() || null;
}

async function requirePrincipal(
  c: Context,
  dependencies: MachineRouteDependencies,
): Promise<MachinePrincipal | Response> {
  const result = await dependencies.authenticate(bearerToken(c));
  if (result.ok) return result.principal;
  if (result.reason === 'account_link_required') {
    return c.json({ reason: 'account_link_required' }, 403);
  }
  return c.json({ error: 'unauthorized' }, 401);
}

function field(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : '';
}

async function readRegisterBody(c: Context): Promise<RegisterBody | null> {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const parsed = {
      installId: field(body.installId, 200),
      name: field(body.name, 200),
      platform: field(body.platform, 80),
      appVersion: field(body.appVersion, 80),
    };
    return Object.values(parsed).every(Boolean) ? parsed : null;
  } catch {
    return null;
  }
}

function internalError(c: Context, route: string, error: unknown): Response {
  console.error(
    `[machines] ${route} failed:`,
    error instanceof Error ? error.message : error,
  );
  return c.json({ error: 'internal' }, 500);
}

export function registerMachineRoutes(
  app: Hono,
  dependencies: MachineRouteDependencies,
): void {
  app.post('/machines/register', async (c) => {
    try {
      const principal = await requirePrincipal(c, dependencies);
      if (principal instanceof Response) return principal;
      const body = await readRegisterBody(c);
      if (!body) return c.json({ error: 'bad_request' }, 400);

      const deviceCap = DEVICE_CAPS[principal.plan];
      const result = await dependencies.store.registerAtomically({
        accountId: principal.accountId,
        machineId: dependencies.newMachineId(),
        installId: body.installId,
        name: body.name,
        platform: body.platform,
        appVersion: body.appVersion,
        deviceCap,
        now: dependencies.now(),
      });
      if (!result.ok) {
        return c.json({
          reason: 'device_cap',
          deviceCap,
          devices: result.devices,
        }, 409);
      }
      return c.json({
        machineId: result.machineId,
        deviceCap,
        devices: result.devices,
      });
    } catch (error) {
      return internalError(c, 'register', error);
    }
  });

  app.get('/machines', async (c) => {
    try {
      const principal = await requirePrincipal(c, dependencies);
      if (principal instanceof Response) return principal;
      return c.json(await dependencies.store.list(principal.accountId));
    } catch (error) {
      return internalError(c, 'list', error);
    }
  });

  app.delete('/machines/:machineId', async (c) => {
    try {
      const principal = await requirePrincipal(c, dependencies);
      if (principal instanceof Response) return principal;
      await dependencies.store.disconnect(
        principal.accountId,
        c.req.param('machineId'),
        dependencies.now(),
      );
      return c.body(null, 204);
    } catch (error) {
      return internalError(c, 'disconnect', error);
    }
  });

  app.post('/machines/:machineId/relay-ticket', async (c) => {
    try {
      const principal = await requirePrincipal(c, dependencies);
      if (principal instanceof Response) return principal;
      if (!dependencies.relayTickets) {
        return c.json({ error: 'not_supported' }, 501);
      }
      const machineId = c.req.param('machineId');
      const machine = (await dependencies.store.list(principal.accountId))
        .find((candidate) => candidate.machineId === machineId);
      if (!machine) return c.json({ error: 'not_found' }, 404);
      const result = await dependencies.relayTickets.mint({
        accountId: principal.accountId,
        machine,
        now: dependencies.now(),
      });
      return c.json({
        ticket: result.ticket,
        expiresAt: new Date(result.expiresAt * 1000).toISOString(),
      });
    } catch (error) {
      return internalError(c, 'relay-ticket', error);
    }
  });

  app.post('/machines/:machineId/heartbeat', async (c) => {
    try {
      const machineId = c.req.param('machineId');
      let accountId: string;
      if (dependencies.relayTickets) {
        const authorized = await dependencies.relayTickets.authorizeHeartbeat(
          bearerToken(c),
          machineId,
        );
        if (!authorized.ok) {
          return authorized.reason === 'account_link_required'
            ? c.json({ reason: 'account_link_required' }, 403)
            : c.json({ error: 'unauthorized' }, 401);
        }
        accountId = authorized.accountId;
      } else {
        const principal = await requirePrincipal(c, dependencies);
        if (principal instanceof Response) return principal;
        accountId = principal.accountId;
      }
      const updated = await dependencies.store.heartbeat(
        accountId,
        machineId,
        dependencies.now(),
      );
      return updated
        ? c.body(null, 204)
        : c.json({ error: 'not_found' }, 404);
    } catch (error) {
      return internalError(c, 'heartbeat', error);
    }
  });
}
