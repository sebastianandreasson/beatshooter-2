# Project loop

`bun install`, then `bun run dev`; `bun test`; `bun test ./<file>`; `bunx playwright test`; `bun run build`; `bun run preview`.

`bunx shallot --skill`

# Remake scope

Read `README.md` and `implementation-plan.md` before adding gameplay.
This is a fresh Shallot implementation; `../beatshooter` is behavioral reference
only. Do not copy its application code, dependencies, credentials, or assets.

Use Bun 1.4.3 or newer and the pinned engine version in `package.json`.
Keep new plugins in `src/<plugin>/index.ts` and follow the installed
`bunx shallot --skill` workflow. The playable M0–M6 implementation is the current
baseline; the unused welcome scene remains an upstream regression fixture.
See `docs/release-smoke.md` for acceptance evidence and remaining human audio
latency sign-off. Deployment is outside this implementation's scope.
