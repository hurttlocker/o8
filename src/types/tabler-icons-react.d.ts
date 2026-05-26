// Subpath modules used to render Tabler icons as raw SVG (matches the
// lucide-react subpath pattern in lucide-react.d.ts). Each .mjs file
// ships an __iconNode data array we render inline via createElement so
// we never invoke the @tabler/icons-react React components — which,
// like lucide-react's React components, don't render in the Tauri webview.
declare module '@tabler/icons-react/dist/esm/icons/*.mjs' {
  export const __iconNode: ReadonlyArray<readonly [string, Record<string, string | number>]>;
}
