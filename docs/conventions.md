# Cortex IDE — Code Conventions

## Styling

**Two patterns coexist — use the right one for the surface:**

| Surface | Pattern | Why |
|---------|---------|-----|
| Mobile components (`src/components/mobile/`) | **Inline `style={{}}`** | iOS Safari safe-area + PWA constraints. No CSS module loading overhead. Predictable in webviews (Tauri, PWA). |
| Desktop components (`src/components/command-center-shell.tsx`, `session-operator-panel.tsx`, `workflow-review-panel.tsx`) | **CSS classes** (`globals.css`) | Desktop layout with grid systems. Class-based responsive breakpoints. |

**Rules:**
- New mobile components: always use inline styles. No CSS classes.
- New desktop components: use CSS classes from `globals.css`.
- Don't mix both in the same component (some legacy components do — don't add more).
- Colors: use iOS system palette (`#007aff`, `#34c759`, `#ff3b30`, `#ff9f0a`, `#af52de`, `#5ac8fa`, `#636366`, `#8e8e93`).
- Background: `#000000` (panels), `#1c1c1e` (cards), `#2c2c2e` (inset elements).

## Components

- **All leaf components must be wrapped in `memo()`** — prevents unnecessary re-renders in the chat scroll path.
- Use `useCallback` for all handler props passed to children.
- Prefer `export const X = memo(function X() {...})` over `export const X = memo(() => {...})` (better DevTools names).

## API Routes

- **Every route must have `export const dynamic = 'force-dynamic'`** — Next.js will otherwise cache or pre-render API responses.
- Worktree routes require auth (`checkAuth` + `WS_TOKEN`). Mobile/Cortex routes are same-origin only.
- Use `NextResponse.json()` for all responses (not `Response`).

## Imports

- Always use `@/` path aliases (e.g., `@/lib/cortex/client`). No relative `../../` chains.
- Every `src/lib/*/` directory has a barrel `index.ts` — prefer importing from the barrel.

## Barrel Exports

Every `src/lib/*/` directory must have an `index.ts` that re-exports its public API.
When adding a new file to a lib directory, update the barrel.
