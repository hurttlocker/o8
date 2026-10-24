import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The verified 0.163.0 npm launcher only selects this payload, adds package
 * manager update hints, and forwards argv/signals. Owned exec already owns the
 * process group and never runs the interactive updater. Skip that Node process.
 * Unknown layouts, custom wrappers and future versions retain the selected CLI.
 */
export async function codexNativeExecBinary(binary: string): Promise<string> {
  if (process.platform === 'win32' || !path.isAbsolute(binary)) return binary;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  const system = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-musl' : null;
  if (!arch || !system) return binary;
  try {
    const entry = await realpath(binary);
    if (path.basename(entry) !== 'codex.js' || path.basename(path.dirname(entry)) !== 'bin') return binary;
    const root = path.dirname(path.dirname(entry));
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== '@openai/codex' || manifest.version !== '0.163.0' || manifest.bin?.codex !== 'bin/codex.js') return binary;

    let vendor = path.join(root, 'vendor');
    const packageName = `@openai/codex-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
    try {
      const packageFile = createRequire(entry).resolve(`${packageName}/package.json`);
      const platformManifest = JSON.parse(await readFile(packageFile, 'utf8'));
      const suffix = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
      if (platformManifest.name !== '@openai/codex' || platformManifest.version !== `${manifest.version}-${suffix}`) return binary;
      vendor = path.join(path.dirname(packageFile), 'vendor');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') return binary;
    }
    const payload = path.join(vendor, `${arch}-${system}`, 'bin', 'codex');
    if (!(await stat(payload)).isFile()) return binary;
    await access(payload, constants.X_OK);
    return payload;
  } catch {
    return binary;
  }
}
