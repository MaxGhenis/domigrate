Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` / `yarn install` / `pnpm install`
- Bun loads `.env` automatically; do not use `dotenv`.

## APIs

- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.file` over `node:fs`'s read/write where possible.
- `Bun.$\`ls\`` instead of `execa`.

## Testing

`bun test`. Tests live in `tests/` and mock `fetch`/Playwright so the
suite runs fully offline.

## Architecture quickstart

- Source registrars: `src/sources/*.ts`; implement `SourceRegistrar`.
- Destination registrars: `src/destinations/*.ts`; implement
  `DestinationRegistrar`.
- Browser-driven source plugins should attach via `src/browser.ts`
  (`connectOverCDP`) and use `src/ai.ts` (`extractFromHtml`) instead of
  hardcoding CSS selectors.
- All state is in SQLite via `src/state.ts`; every operation must be
  idempotent — re-running a command after a crash must be safe.
