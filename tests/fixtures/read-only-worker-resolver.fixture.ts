import { resolveReadOnlyWorkerToken } from '../../src/lib/auth/read-only-worker-token';
import { getSqlite } from '../../src/lib/db';
console.log = () => {};
process.stdout.write(JSON.stringify({ identity: resolveReadOnlyWorkerToken(process.argv[2] ?? '') }));
getSqlite().close();
