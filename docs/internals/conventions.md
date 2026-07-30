# o8 Code Conventions

## Styling

- New TSX uses inline `style={{ ... }}` on desktop and mobile. Existing legacy
  classes do not authorize new classes.
- Themeable colors and surfaces use `var(--t-*)`; do not add hardcoded
  light-only or dark-only surface colors.
- Use longhand spacing properties (`paddingTop`, `paddingRight`, and so on);
  React 19 warns when shorthand and longhand mix.
- Desktop icons use the established raw-SVG/shim pattern. Do not add React icon
  component imports.
- Keep hooks unconditional. Never put `return null` before hooks.

## Components

- Use `memo`, `useMemo`, and `useCallback` only where identity or measured
  rendering cost requires them.
- Keep files under the 800-line ceiling unless the repository guide names an
  existing waiver.
- Match the component vocabulary and geometry in `Hurttlocker.md`, `DESIGN.md`,
  and `STYLEGUIDE.md`.

## API Routes

- `/api/*` is default-deny. New routes need an explicit middleware policy and
  route-coverage test; loopback alone is not operator authority.
- Return structured error responses instead of throwing to Next.js.
- Use the Node.js App Router runtime by default. Export
  `dynamic = 'force-dynamic'` only when the route's caching semantics require
  it.

## Imports

- Always use `@/` path aliases (e.g., `@/lib/cortex/client`). No relative `../../` chains.
- Import from an existing barrel when it is the documented public boundary;
  do not create barrels mechanically for every directory.
