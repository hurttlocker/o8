/**
 * Tool-Spine barrel — registry types + the pure emitters.
 *
 * `build.ts` is deliberately NOT re-exported here: it imports DB/ws/api-port and
 * must only run in the Next server runtime, whereas everything exported below is
 * import-pure (no fs, no DB) and safe to copy into a standalone process. Server
 * callers import `buildToolRegistry` directly from `./build`.
 */

export * from './registry';
export * from './emit-claude';
export * from './emit-codex';
export * from './emit-claude-desktop';
export * from './emit-openclaw';
export * from './emit-gemini';
export * from './emit-opencode';
