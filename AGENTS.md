# Project loop

`bun install`, then `bun run dev`; `bun test`; `bun test ./<file>`; `bunx playwright test`; `bun run build`; `bun run preview`.

`bunx shallot --skill`

# Remake scope

Read `README.md` and `implementation-plan.md` before adding gameplay.
This is a fresh Shallot implementation; `../beatshooter` is behavioral reference
only. Do not copy its application code, dependencies, credentials, or assets.

Use Bun 1.4.3 or newer and the pinned engine version in `package.json`.
Keep new plugins in `src/<plugin>/index.ts` and follow the installed
`bunx shallot --skill` workflow. The welcome scene is the current baseline;
planned gameplay is not implemented yet.
