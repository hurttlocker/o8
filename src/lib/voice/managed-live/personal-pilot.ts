import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { importSPKI, jwtVerify } from 'jose';
import { getDataDir } from '@/lib/data-dir-migration';
import { LICENSE_PUBLIC_KEY_PEM, verifyLicense } from '@/lib/entitlement/license';
import { PERSONAL_PILOT_PUBLIC_KEY } from './personal-pilot-key';

export interface PersonalPilot { gateway: string; id: string; expiresAt: number }
export interface PilotAccount { accountId: string | null; epoch: string | null }
export const PERSONAL_PILOT_ISSUER = 'o8-personal-voice-pilot';
export const PERSONAL_PILOT_AUDIENCE = 'o8-desktop';
export function personalPilotInstallation(directory: string, epoch: string): string {
  return createHash('sha256').update(JSON.stringify(['personal-pilot-v1', realpathSync(directory), epoch])).digest('hex');
}

/** Paid live access never accepts the offline grace or a development trust-root override. */
export async function verifyPersonalVoiceAccount(token: string, account: PilotAccount): Promise<void> {
  const license = await verifyLicense(token, { publicKeyPem: LICENSE_PUBLIC_KEY_PEM, offlineGrace: false });
  if (!license.valid || !license.subject || license.subject !== account.accountId || !account.epoch
    || license.plan === 'free') throw new Error('Personal voice account unavailable');
}

/** An installed pilot is a separately signed local experiment, never managed-service activation. */
export async function personalVoicePilot(token: string, account: PilotAccount): Promise<PersonalPilot | null> {
  const directory = getDataDir();
  let fd: number;
  try { fd = openSync(join(directory, 'managed-voice-pilot.jwt'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Personal pilot unavailable'); }
  let grant: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Unsafe personal pilot');
    grant = readFileSync(fd, 'utf8').trim();
  } finally { closeSync(fd); }
  await verifyPersonalVoiceAccount(token, account);
  const key = await importSPKI(PERSONAL_PILOT_PUBLIC_KEY, 'EdDSA');
  const { payload } = await jwtVerify(grant, key, {
    algorithms: ['EdDSA'], issuer: PERSONAL_PILOT_ISSUER, audience: PERSONAL_PILOT_AUDIENCE,
    requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'jti'], clockTolerance: 0,
  });
  const now = Math.floor(Date.now() / 1000);
  if (payload.version !== 1 || payload.purpose !== 'personal-live-experiment' || payload.sub !== account.accountId
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.nbf !== payload.iat
    || payload.iat! > now || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 24 * 60 * 60
    || typeof payload.jti !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.jti)
    || payload.installation !== personalPilotInstallation(directory, account.epoch!)) throw new Error('Personal pilot not admitted');
  if (typeof payload.gateway !== 'string') throw new Error('Personal relay unavailable');
  const url = new URL(payload.gateway);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.origin !== payload.gateway
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Personal relay must be loopback');
  return { gateway: url.origin, id: payload.jti, expiresAt: payload.exp! * 1000 };
}
