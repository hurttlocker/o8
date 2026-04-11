// Stub for the `server-only` marker package. Next.js ships its own alias
// via webpack, but esbuild (used for our standalone ws-server.mjs and MCP
// server bundles) doesn't know how to resolve it. At runtime the marker is
// a no-op in a server-side process, so a bare empty module is correct.
export {};
