import { errors as joseErrors, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';

import {
  RELAY_TICKET_TTL_SECONDS,
  type MachineAuthResult,
} from './machines-core.js';

export const MACHINE_RELAY_AUDIENCE = 'o8-relay';

export interface MachineRelayTicketClaims {
  accountId: string;
  machineId: string;
  installId: string;
  exp: number;
}

export interface MintMachineRelayTicketInput {
  accountId: string;
  machineId: string;
  installId: string;
}

export interface MintMachineRelayTicketOptions {
  privateKeyPem: string;
  issuer: string;
  now?: Date;
  ttlSeconds?: number;
}

export interface VerifyMachineRelayTicketOptions {
  publicKeyPem: string;
  issuer: string;
  now?: Date;
}

export type MachineRelayTicketVerification =
  | { ok: true; claims: MachineRelayTicketClaims }
  | {
    ok: false;
    reason: 'malformed' | 'expired' | 'wrong_audience' | 'invalid_claims' | 'invalid';
  };

export type MachineHeartbeatAuthResult =
  | { ok: true; accountId: string }
  | {
    ok: false;
    status: 401 | 403;
    reason: 'unauthorized' | 'account_link_required';
  };

type ImportedPublicKey = Awaited<ReturnType<typeof importSPKI>>;
const publicKeyCache = new Map<string, Promise<ImportedPublicKey>>();

function importPublicKey(pem: string): Promise<ImportedPublicKey> {
  let pending = publicKeyCache.get(pem);
  if (!pending) {
    pending = importSPKI(pem, 'EdDSA');
    publicKeyCache.set(pem, pending);
  }
  return pending;
}

export async function mintMachineRelayTicketWith(
  input: MintMachineRelayTicketInput,
  options: MintMachineRelayTicketOptions,
): Promise<{ ticket: string; expiresAt: number }> {
  const key = await importPKCS8(options.privateKeyPem, 'EdDSA');
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const expiresAt = nowSec + (options.ttlSeconds ?? RELAY_TICKET_TTL_SECONDS);
  const ticket = await new SignJWT({
    accountId: input.accountId,
    machineId: input.machineId,
    installId: input.installId,
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(options.issuer)
    .setAudience(MACHINE_RELAY_AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(expiresAt)
    .sign(key);
  return { ticket, expiresAt };
}

export async function verifyMachineRelayTicketWith(
  token: string | null | undefined,
  options: VerifyMachineRelayTicketOptions,
): Promise<MachineRelayTicketVerification> {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw || raw.split('.').length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  try {
    const key = await importPublicKey(options.publicKeyPem);
    const verified = await jwtVerify(raw, key, {
      algorithms: ['EdDSA'],
      audience: MACHINE_RELAY_AUDIENCE,
      issuer: options.issuer,
      clockTolerance: 0,
      currentDate: options.now,
    });
    const payload = verified.payload;
    if (
      typeof payload.accountId !== 'string'
      || !payload.accountId
      || typeof payload.machineId !== 'string'
      || !payload.machineId
      || typeof payload.installId !== 'string'
      || !payload.installId
      || typeof payload.exp !== 'number'
    ) {
      return { ok: false, reason: 'invalid_claims' };
    }
    return {
      ok: true,
      claims: {
        accountId: payload.accountId,
        machineId: payload.machineId,
        installId: payload.installId,
        exp: payload.exp,
      },
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired' };
    }
    if (
      error instanceof joseErrors.JWTClaimValidationFailed
      && error.claim === 'aud'
    ) {
      return { ok: false, reason: 'wrong_audience' };
    }
    return { ok: false, reason: 'invalid' };
  }
}

export async function authorizeMachineHeartbeat(input: {
  token: string | null;
  machineId: string;
  verifyTicket(
    token: string,
  ): Promise<MachineRelayTicketVerification>;
  authenticateAccount(token: string | null): Promise<MachineAuthResult>;
}): Promise<MachineHeartbeatAuthResult> {
  const ticket = input.token
    ? await input.verifyTicket(input.token)
    : { ok: false as const, reason: 'malformed' as const };
  if (ticket.ok) {
    return ticket.claims.machineId === input.machineId
      ? { ok: true, accountId: ticket.claims.accountId }
      : { ok: false, status: 401, reason: 'unauthorized' };
  }

  const account = await input.authenticateAccount(input.token);
  if (!account.ok) return account;
  return { ok: true, accountId: account.principal.accountId };
}
