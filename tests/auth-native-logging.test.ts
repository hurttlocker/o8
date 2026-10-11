import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const vendorRoot = 'src-tauri/vendor';
const crates = [
  { name: 'tauri-plugin-clerk', version: '0.1.1' },
  { name: 'clerk-fapi-rs', version: '0.2.0' },
];

function rustSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? rustSources(entryPath) : entry.name.endsWith('.rs') ? [entryPath] : [];
  });
}

describe('native auth diagnostic source boundary', () => {
  it('selects the patched native crates without changing their pinned versions', () => {
    const manifest = readFileSync('src-tauri/Cargo.toml', 'utf8');
    const patchSection = manifest.split('[patch.crates-io]')[1];
    const lockPackages = readFileSync('src-tauri/Cargo.lock', 'utf8').split('[[package]]');
    for (const { name, version } of crates) {
      expect(patchSection).toContain(`${name} = { path = "vendor/${name}-${version}" }`);
      const resolved = lockPackages.filter((section) => section.includes(`name = "${name}"`));
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toContain(`version = "${version}"`);
      expect(resolved[0]).not.toMatch(/^(source|checksum) =/m);
      const nativeManifest = readFileSync(`${vendorRoot}/${name}-${version}/Cargo.toml`, 'utf8');
      expect(nativeManifest).toContain(`name = "${name}"`);
      expect(nativeManifest).toContain(`version = "${version}"`);
    }
  });

  it('allows only fixed literal messages at every active native dependency diagnostic sink', () => {
    // This intentionally checks the actual dependency source, not a helper-only
    // simulation. Runtime compilation still requires the native toolchain.
    let sinkCount = 0;
    const syntheticSecrets = [
      'SYNTHETIC_AUTH_SECRET_NOT_VALID',
      'o8://auth/callback?ticket=SYNTHETIC_TICKET&state=SYNTHETIC_STATE',
    ];
    for (const { name, version } of crates) {
      for (const sourcePath of rustSources(`${vendorRoot}/${name}-${version}/src`)) {
        const source = readFileSync(sourcePath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const sinks = source.matchAll(/\b(?:debug|info|warn|error|trace|println|eprintln)!\s*\(([^]*?)\)\s*;/g);
        for (const sink of sinks) {
          sinkCount += 1;
          const argument = sink[1].trim();
          // No formatting arguments and no implicit Rust format captures.
          expect(argument, sourcePath).toMatch(/^"(?:[^"\\]|\\.)*"$/);
          expect(argument, sourcePath).not.toMatch(/[{}]/);
          for (const secret of syntheticSecrets) expect(argument).not.toContain(secret);
          expect(sink[0], sourcePath).not.toMatch(/\b(?:println|eprintln)!/);
        }
      }
    }
    expect(sinkCount).toBeGreaterThan(15);
  });

  it('preserves token-bearing auth transport and native authorization persistence', () => {
    const plugin = `${vendorRoot}/tauri-plugin-clerk-0.1.1/src`;
    const fapi = `${vendorRoot}/clerk-fapi-rs-0.2.0/src`;
    expect(readFileSync(`${plugin}/events.rs`, 'utf8')).toContain('ClerkAuthEvent {\n            source: RUST_EVENT_SOURCE.to_string(),\n            payload,');
    expect(readFileSync(`${plugin}/commands.rs`, 'utf8')).toContain('app.clerk().set_client_authorization_header(header)');
    expect(readFileSync(`${fapi}/clerk_http_client.rs`, 'utf8')).toContain('req.headers_mut().insert("Authorization", value);');
    expect(readFileSync(`${fapi}/clerk_http_client.rs`, 'utf8')).toContain('state.set_authorization_header(Some(auth_str.to_string()));');
    expect(readFileSync(`${fapi}/models/client_session.rs`, 'utf8')).toContain('pub last_active_token: Option<Option<Box<models::Token>>>');
  });
});
