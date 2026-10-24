import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Injectable host and module resolution keep platform tests independent of installs.
export function resolveTypecheckChecker({
  platform = process.platform,
  arch = process.arch,
  libc = platform === 'linux'
    ? (process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl')
    : undefined,
  resolve = require.resolve,
  stderr = (line) => process.stderr.write(line),
  allowFallback = true,
} = {}) {
  const target = `${platform}-${arch}${platform === 'linux' ? `-${libc}` : ''}`;
  try {
    resolve(`@tsrs/${target}/package.json`);
    return { name: 'tsrs', path: join(dirname(resolve('tsrs/package.json')), 'bin', 'tsrs') };
  } catch {
    const message = `tsrs has no ${platform}-${arch} build`;
    if (!allowFallback) throw new Error(`${message}; parity requires both tsc 5.8.2 and tsrs`);
    const path = resolve('typescript/bin/tsc');
    stderr(`${message}; using tsc 5.8.2\n`);
    return { name: 'tsc', path };
  }
}
