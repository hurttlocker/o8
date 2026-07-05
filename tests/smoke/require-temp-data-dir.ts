import assert from 'node:assert';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const setup = 'CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS=\'--conditions=react-server\' npx tsx <smoke-file>';
const dataDir = process.env.CORTEX_IDE_DATA_DIR;

assert(
  dataDir,
  `CORTEX_IDE_DATA_DIR must be set to an isolated temp dir.\nRun: ${setup}`,
);

assert(
  existsSync(dataDir),
  `CORTEX_IDE_DATA_DIR must point at an existing isolated temp dir.\nRun: ${setup}`,
);

const actual = realpathSync(dataDir);
const realDefault = existsSync(resolve(homedir(), '.o8'))
  ? realpathSync(resolve(homedir(), '.o8'))
  : resolve(homedir(), '.o8');

assert.notStrictEqual(
  actual,
  realDefault,
  `Refusing to run smoke against the real ~/.o8 data dir: ${actual}\nRun: ${setup}`,
);

export const smokeDataDir = dataDir;
