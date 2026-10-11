/**
 * CSP does not cover WebRTC. Seal every executable inline script together with
 * this guard: child srcdoc documents inherit the hashes, so they cannot run an
 * unguarded script in a fresh realm. Opaque sandbox origins also prevent reading
 * constructors from an empty child frame, including before its first navigation.
 * Classic scripts use the unshadowable top-level `this`, not a payload's window.
 */
const GUARD = `;(function(realm) {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
    realm.Object.defineProperty(realm, name, { value: undefined, configurable: false, writable: false });
    const descriptor = realm.Object.getOwnPropertyDescriptor(realm, name);
    if (!descriptor || descriptor.value !== undefined || descriptor.configurable || descriptor.writable) throw new Error('Visualization isolation unavailable');
  }
})(this);\n`;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sealVisualizationScripts(html: string): Promise<{ html: string; policy: string }> {
  const scripts: string[] = [];
  // HTML parsing normalizes line endings and NUL before CSP computes hashes.
  const normalized = html.replace(/\r\n?/g, '\n').replace(/\0/g, '\ufffd');
  const sealed = normalized.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (tag, attributes: string, body: string) => {
    const type = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const mime = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().toLowerCase();
    // Data blocks keep their exact JSON, but receive no executable hash.
    if (mime === 'application/json' || mime === 'application/ld+json' || mime === 'text/plain') return tag;
    const script = GUARD + body;
    scripts.push(script);
    return `<script${attributes}>${script}</script>`;
  });
  const hashes = await Promise.all(scripts.map(async script => {
    const bytes = new TextEncoder().encode(script);
    return `'sha256-${base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))}'`;
  }));
  return { html: sealed, policy: `script-src ${hashes.length ? [...new Set(hashes)].join(' ') : "'none'"}` };
}
