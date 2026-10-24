import { spawnSync } from 'node:child_process';
import { resolveTypecheckChecker } from './typecheck-checker.mjs';

const checker = resolveTypecheckChecker();
const result = spawnSync(process.execPath, [checker.path, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
