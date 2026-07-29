import { errors as joseErrors, importSPKI, jwtVerify } from 'jose';

export const MACHINE_RELAY_AUDIENCE = 'o8-relay';

export interface MachineTicketClaims {
  accountId: string;
  machineId: string;
  installId: string;
  exp: number;
}

export type MachineTicketResult =
  | { ok: true; claims: MachineTicketClaims }
  | {
    ok: false;
    reason: 'malformed' | 'expired' | 'wrong_audience' | 'invalid_claims' | 'invalid';
  };

export interface VerifyMachineTicketOptions {
  publicKeyPem: string;
  issuer: string;
  now?: Date;
}

type ImportedKey = Awaited<ReturnType<typeof importSPKI>>;
const keyCache = new Map<string, Promise<ImportedKey>>();

function importKey(pem: string): Promise<ImportedKey> {
  let pending = keyCache.get(pem);
  if (!pending) {
    pending = importSPKI(pem, 'EdDSA');
    keyCache.set(pem, pending);
  }
  return pending;
}

export async function verifyMachineRelayTicketWith(
  token: string | null | undefined,
  options: VerifyMachineTicketOptions,
): Promise<MachineTicketResult> {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw || raw.split('.').length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  try {
    const key = await importKey(options.publicKeyPem);
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
