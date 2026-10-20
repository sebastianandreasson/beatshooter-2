# beatshooter-2

A fresh remake of Beatshooter using [Shallot](https://github.com/dylanebert/shallot).
The original `../beatshooter` is a reference for gameplay ideas; this project has
its own implementation, dependencies, and assets.

## Current state

The official **minimal** starter is installed: a turning cube, ground, lighting,
and an orbit camera. Shooter gameplay and music timing are planned, not implemented.
See [implementation-plan.md](implementation-plan.md) for the proposed milestones,
acceptance criteria, and links to relevant Shallot examples.

Created using the [upstream quick start](https://github.com/dylanebert/shallot/blob/v0.10.0/README.md):

```sh
# From the parent directory; already completed for this checkout.
bun create shallot@0.10.0 beatshooter-2
```

The engine package is `@dylanebert/shallot`, pinned to **0.10.0**. This was the
current stable release when setup was checked on 2026-10-20. The unscoped npm
package `shallot` is a different project; use the local CLI through `bunx shallot`.

## Requirements and commands

- **Bun 1.4.3 or newer**; `.bun-version` and `packageManager` record the setup version.
  See the [Bun installation instructions](https://bun.sh/docs/installation).
- A browser with WebGPU available, running on localhost or HTTPS.

```sh
bun --version
bun install
bun run dev
```

Open the URL printed by Vite. Edit `src/welcome/index.ts` to change the starter
scene; the page reloads when it changes.

```sh
# Type checking and the starter's unit test
bun check
bun test

# Browser checks; install the test browser once
bunx playwright install chromium
bunx playwright test

# Production build and local preview
bun run build
bun run preview

# Engine commands and project guidance
bunx shallot --help
bunx shallot --skill
```

`bun.lock` records the installed dependency versions. Use
`bun install --frozen-lockfile` when reproducing this checkout.

The shell's Bun was 1.3.11 during setup, so verification used an isolated Bun 1.4.3
installation. The global Bun installation was not changed; select or install
Bun 1.4.3+ before using the full workflow above.

Verified on 2026-10-20: `bun check`, the starter's unit test, all four browser
startup tests, and the production build passed. The build reports the upstream
starter's large-chunk warning.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | Canvas, loading screen, and application entry |
| `src/welcome/` | Official starter plugin and unit test |
| `public/` | Starter icon and startup error handler |
| `vite.config.ts` | Shallot's Vite plugin |
| `bunfig.toml`, `tests/preload.ts` | Shallot's Bun/TypeGPU test setup |
| `startup.e2e.ts`, `playwright.config.ts` | Official browser startup checks |
| `.github/workflows/test.yml` | Generated unit/browser CI workflow |
| `implementation-plan.md` | Remake scope, architecture, and implementation sequence |

## Hosting

`bun run dev`, `bun run preview`, and Shallot's native shell serve cross-origin
isolation headers. A future static deployment should preserve those headers;
Shallot physics otherwise falls back to a single thread. No deployment is
configured in this starter.

Music for the remake is planned around local files and bundled tracks with
explicit beat data. The plan explains why the original Spotify integration is
excluded from the proposed implementation.
