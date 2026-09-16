import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'o8/intake-reconciliation/v1';
const SETTING = 'O8_INTAKE_RECONCILIATION';

function receipt(status, extra = {}) {
  return { schema: SCHEMA, status, ...extra };
}

function credentialFile(env) {
  // O8_OPERATOR_DATA_DIR wins because the ship deliberately relocates
  // O8_DATA_DIR to a throwaway build directory so the release cannot inherit
  // the operator's runtime state (scripts/lib/ship-broadcast.mjs,
  // runShipWorkflow). That isolation is correct for build state and wrong for
  // this credential: the publish step runs as a child of that workflow, so it
  // looked for the intake token inside the empty temp directory and reported
  // "not configured" on every ship, which silently skipped reconciling anyone
  // else's bug reports. The ship now names the operator's real directory here.
  const dataDir = env.O8_OPERATOR_DATA_DIR
    || env.O8_DATA_DIR
    || env.CORTEX_IDE_DATA_DIR
    || path.join(env.HOME || os.homedir(), '.o8');
  return path.join(dataDir, 'discord-bot-token');
}

export function resolveIntakeReconciliation(options = {}) {
  const env = options.env ?? process.env;
  const read = options.readFile ?? readFileSync;
  const stat = options.stat ?? statSync;
  const configuredMode = env[SETTING]?.trim().toLowerCase() || 'enabled';

  if (configuredMode === 'disabled') {
    return { inspection: receipt('disabled'), credential: null };
  }
  if (configuredMode !== 'enabled') {
    return {
      inspection: receipt('misconfigured', {
        reason: `${SETTING} must be "enabled" or "disabled"`,
      }),
      credential: null,
    };
  }

  const fromEnv = env.O8_DISCORD_BOT_TOKEN?.trim();
  if (fromEnv) {
    return {
      inspection: receipt('configured', { source: 'environment' }),
      credential: fromEnv,
    };
  }

  const file = credentialFile(env);
  let fileStats;
  try {
    fileStats = stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        inspection: receipt('missing', {
          reason: 'the external intake read credential is not configured',
        }),
        credential: null,
      };
    }
    return {
      inspection: receipt('misconfigured', {
        reason: 'the runtime credential file could not be inspected',
      }),
      credential: null,
    };
  }

  if (!fileStats.isFile()) {
    return {
      inspection: receipt('misconfigured', {
        reason: 'the runtime credential path is not a regular file',
      }),
      credential: null,
    };
  }
  if (process.platform !== 'win32' && (fileStats.mode & 0o077) !== 0) {
    return {
      inspection: receipt('misconfigured', {
        reason: 'the runtime credential file must not be accessible by group or other users',
      }),
      credential: null,
    };
  }

  let fromFile;
  try {
    fromFile = read(file, 'utf8').trim();
  } catch {
    return {
      inspection: receipt('misconfigured', {
        reason: 'the runtime credential file could not be read',
      }),
      credential: null,
    };
  }
  if (!fromFile) {
    return {
      inspection: receipt('misconfigured', {
        reason: 'the runtime credential file is empty',
      }),
      credential: null,
    };
  }
  return {
    inspection: receipt('configured', { source: 'runtime-file' }),
    credential: fromFile,
  };
}

export function inspectIntakeReconciliation(options = {}) {
  return resolveIntakeReconciliation(options).inspection;
}

export function intakeReconciliationDiagnostic(inspection) {
  if (inspection.status === 'configured') {
    return `external intake reconciliation is configured through ${inspection.source}`;
  }
  if (inspection.status === 'disabled') {
    return 'external intake reconciliation is intentionally disabled';
  }
  return `external intake reconciliation is ${inspection.status}: ${inspection.reason}`;
}
