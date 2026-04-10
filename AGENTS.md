# Repository Guidelines

## Project Structure & Module Organization
`src/app` contains the Next.js App Router pages and API routes. `src/components` holds UI surfaces, with major splits for `desktop`, `mobile`, and `landing`. Shared logic lives in `src/lib` by domain (`runtime`, `worktree`, `openclaw`, `cortex`, `review`, etc.). `src/ws-server.ts` runs the standalone WebSocket bridge used by the mobile shell. Native desktop packaging lives in `src-tauri`. Product notes, specs, and architecture docs live in `docs`; static assets are in `public` and `assets`.

## Brand Direction
Read [`BRAND.md`](./BRAND.md) before making desktop or mobile visual changes. It defines the current product theme, spacing, color, motion, and component language.

## Build, Test, and Development Commands
Use `npm install` to sync dependencies.

- `npm run dev`: starts Next.js on `http://localhost:3001`
- `npm run dev:ws`: starts the WebSocket server on port `3002`
- `npm run desktop:dev`: runs the web app and WS server together for normal UI work
- `npm run build`: creates the production Next.js build
- `npm run start`: serves the production build on port `3001`
- `npm run lint`: runs ESLint across the repo
- `npm run typecheck`: runs strict TypeScript checks with `tsc --noEmit`
- `npm run tauri:dev` / `npm run tauri:build`: run or package the native Tauri shell

## Coding Style & Naming Conventions
This repo uses TypeScript in `strict` mode and the Next.js ESLint flat config in [`eslint.config.mjs`](./eslint.config.mjs). Match the existing style: 2-space indentation, single quotes, semicolons, and concise comments only where the flow is not obvious. Use `PascalCase` for React components (`DesktopChat.tsx`), `camelCase` for functions and utilities, and keep domain files grouped under `src/lib/<domain>`. Prefer the `@/` path alias over long relative imports.

## Testing Guidelines
No automated test runner is configured yet. For every change, run `npm run lint` and `npm run typecheck`, then smoke-test the affected routes, especially `/`, `/dashboard`, `/landing`, and `/mobile` when UI behavior changes. Validate API and WS changes with the local bridge running via `npm run desktop:dev` or `npm run dev:ws`.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:` and `fix:`. Keep commits focused and imperative, for example `fix: prevent stale mobile transcript replay`. PRs should include a short problem/solution summary, linked issue or design doc when relevant, and manual verification steps. Include screenshots or recordings for desktop/mobile UI changes and note any required env vars in `.env.local` such as `WS_TOKEN`, `GEMINI_API_KEY`, or `VERCEL_TOKEN`.
