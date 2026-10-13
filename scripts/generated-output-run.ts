import { createRequire } from 'node:module';
import path from 'node:path';

import { boundBuildEnvironment } from './lib/release-build-profile.mjs';

async function main(): Promise<number> {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const [mode, ...args] = process.argv.slice(2);
  if (mode !== 'prebuild') Object.assign(process.env, boundBuildEnvironment(process.cwd()));
  const { runGeneratedOutputPrebuild, runGeneratedOutputProducer } = await import('../src/lib/workspace/generated-output-producer');
  if (mode === 'prebuild') {
    const { prebuildPreflight, runPrebuild } = await import('./lib/prebuild-continuation.mjs');
    return runGeneratedOutputPrebuild({ workspacePath: process.cwd(), preflight: prebuildPreflight, operation: runPrebuild });
  }
  if (mode !== 'build' && mode !== 'dev' && mode !== 'start') {
    throw new Error('Generated-output runner requires build, dev or start.');
  }
  return runGeneratedOutputProducer({ workspacePath: process.cwd(), mode,
    operation: async run => {
      if (mode === 'build') {
        const { runRegisteredBuild } = await import('./lib/registered-build.mjs');
        return runRegisteredBuild(run);
      }
      return run(process.execPath, [require.resolve('next/dist/bin/next'), mode, ...args]);
    } });
}

void main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`Generated-output producer refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
