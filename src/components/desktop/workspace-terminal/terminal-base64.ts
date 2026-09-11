// Avoid the iterator and callback-per-byte allocation in Uint8Array.from.
// Keep atob's validation and byte semantics on every supported webview.
export function decodeTerminalBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
