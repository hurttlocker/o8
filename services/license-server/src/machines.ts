import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { Hono } from 'hono';

import { verifyClerkSession } from './clerk-verify.js';
import { db } from './db/client.js';
import { founders, installLinks, machines, subscriptions } from './db/schema.js';
import {
  registerMachineRoutes,
  type MachineAuthResult,
  type MachineDevice,
  type MachinePlan,
  type MachineRegistration,
  type MachineRegistrationResult,
  type MachineStore,
} from './machines-core.js';
import { env } from './env.js';
import {
  authorizeMachineHeartbeat,
  mintMachineRelayTicketWith,
  verifyMachineRelayTicketWith,
} from './relay-ticket.js';
import { getDerivedPublicKeyPem, validateEntitlement } from './validate.js';

function isMachinePlan(value: unknown): value is MachinePlan {
  return value === 'free'
    || value === 'pro'
    || value === 'team';
}

async function resolveClerkPlan(clerkUserId: string): Promise<MachinePlan> {
  const paid = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.clerkUserId, clerkUserId),
        isNull(subscriptions.revokedAt),
      ),
    )
    .limit(1);
  if (isMachinePlan(paid[0]?.plan)) return paid[0].plan;

  const founding = await db
    .select({ id: founders.id })
    .from(founders)
    .where(
      and(
        eq(founders.clerkUserId, clerkUserId),
        eq(founders.status, 'active'),
        isNull(founders.revokedAt),
      ),
    )
    .limit(1);
  // Founding Operator is a lifetime Pro-equivalent entitlement, so it uses
  // the ruled Pro connect allowance rather than inventing a fourth cap.
  return founding.length > 0 ? 'pro' : 'free';
}

export async function authenticateMachine(token: string | null): Promise<MachineAuthResult> {
  if (!token) return { ok: false, status: 401, reason: 'unauthorized' };

  const license = await validateEntitlement(token);
  if (license.valid && license.plan && license.sub) {
    let accountId = license.sub;
    if (license.sub.startsWith('install:')) {
      const links = await db
        .select({ clerkUserId: installLinks.clerkUserId })
        .from(installLinks)
        .where(eq(installLinks.installSub, license.sub))
        .limit(1);
      if (!links[0]?.clerkUserId) {
        return { ok: false, status: 403, reason: 'account_link_required' };
      }
      accountId = links[0].clerkUserId;
    }
    return {
      ok: true,
      principal: {
        accountId,
        plan: license.plan === 'founder' ? 'pro' : license.plan,
      },
    };
  }

  const clerkUserId = await verifyClerkSession(token);
  if (!clerkUserId) return { ok: false, status: 401, reason: 'unauthorized' };
  return {
    ok: true,
    principal: {
      accountId: clerkUserId,
      plan: await resolveClerkPlan(clerkUserId),
    },
  };
}

interface MachineRow {
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
}

function toDevice(row: MachineRow): MachineDevice {
  return {
    machineId: row.machineId,
    installId: row.installId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

const postgresMachineStore: MachineStore = {
  async registerAtomically(
    input: MachineRegistration,
  ): Promise<MachineRegistrationResult> {
    return db.transaction(async (transaction) => {
      // Serialize every registration decision for one account. The advisory
      // lock is transaction-scoped, so concurrent cap+1 requests cannot both
      // observe the same active count and insert.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.accountId}))`,
      );

      const existingRows = await transaction
        .select()
        .from(machines)
        .where(
          and(
            eq(machines.accountId, input.accountId),
            eq(machines.installId, input.installId),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      const needsActiveSlot = !existing || existing.disconnectedAt !== null;

      if (needsActiveSlot) {
        const countRows = await transaction
          .select({ value: count() })
          .from(machines)
          .where(
            and(
              eq(machines.accountId, input.accountId),
              isNull(machines.disconnectedAt),
            ),
          );
        if ((countRows[0]?.value ?? 0) >= input.deviceCap) {
          const rows = await transaction
            .select()
            .from(machines)
            .where(
              and(
                eq(machines.accountId, input.accountId),
                isNull(machines.disconnectedAt),
              ),
            )
            .orderBy(asc(machines.createdAt), asc(machines.machineId));
          return { ok: false, devices: rows.map(toDevice) };
        }
      }

      const machineId = existing?.machineId ?? input.machineId;
      if (existing) {
        await transaction
          .update(machines)
          .set({
            name: input.name,
            platform: input.platform,
            appVersion: input.appVersion,
            lastSeenAt: input.now,
            disconnectedAt: null,
          })
          .where(
            and(
              eq(machines.accountId, input.accountId),
              eq(machines.machineId, existing.machineId),
            ),
          );
      } else {
        await transaction.insert(machines).values({
          machineId,
          accountId: input.accountId,
          installId: input.installId,
          name: input.name,
          platform: input.platform,
          appVersion: input.appVersion,
          createdAt: input.now,
          lastSeenAt: input.now,
        });
      }

      const rows = await transaction
        .select()
        .from(machines)
        .where(
          and(
            eq(machines.accountId, input.accountId),
            isNull(machines.disconnectedAt),
          ),
        )
        .orderBy(asc(machines.createdAt), asc(machines.machineId));
      return { ok: true, machineId, devices: rows.map(toDevice) };
    });
  },

  async list(accountId: string): Promise<MachineDevice[]> {
    const rows = await db
      .select()
      .from(machines)
      .where(
        and(
          eq(machines.accountId, accountId),
          isNull(machines.disconnectedAt),
        ),
      )
      .orderBy(asc(machines.createdAt), asc(machines.machineId));
    return rows.map(toDevice);
  },

  async disconnect(accountId: string, machineId: string, now: Date): Promise<void> {
    await db
      .update(machines)
      .set({ disconnectedAt: now })
      .where(
        and(
          eq(machines.accountId, accountId),
          eq(machines.machineId, machineId),
          isNull(machines.disconnectedAt),
        ),
      );
  },

  async heartbeat(accountId: string, machineId: string, now: Date): Promise<boolean> {
    const updated = await db
      .update(machines)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(machines.accountId, accountId),
          eq(machines.machineId, machineId),
          isNull(machines.disconnectedAt),
        ),
      )
      .returning({ machineId: machines.machineId });
    return updated.length > 0;
  },
};

export function registerProductionMachineRoutes(app: Hono): void {
  registerMachineRoutes(app, {
    authenticate: authenticateMachine,
    store: postgresMachineStore,
    now: () => new Date(),
    newMachineId: () => randomUUID(),
    relayTickets: {
      mint: ({ accountId, machine, now }) => mintMachineRelayTicketWith({
        accountId,
        machineId: machine.machineId,
        installId: machine.installId,
      }, {
        privateKeyPem: env.LICENSE_PRIVATE_KEY,
        issuer: env.ISSUER,
        now,
      }),
      authorizeHeartbeat: (token, machineId) => authorizeMachineHeartbeat({
        token,
        machineId,
        verifyTicket: (candidate) => verifyMachineRelayTicketWith(candidate, {
          publicKeyPem: getDerivedPublicKeyPem(),
          issuer: env.ISSUER,
        }),
        authenticateAccount: authenticateMachine,
      }),
    },
  });
}
