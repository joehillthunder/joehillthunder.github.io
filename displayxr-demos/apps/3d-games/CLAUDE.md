# CLAUDE.md — 3d-games

A guide to the best commercial games on the Leia SR runtime (true-stereo profiles only), plus three game pages with
playable woven tribute dioramas. Read `../../CLAUDE.md` first: its rules apply here too.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/3d-games/
**Branch:** `app/stereo-games` (or `app/stereo-games-<topic>`). Ship through a PR to `main`.
**In DisplayXR HQ:** the `3d-games` entry ("3D Game Guide") is the last room of the Gaming wing
(`home/demos.js`), with a `BUILD['3d-games']` set piece in `home/office.js`: a shelf of game boxes
and three plinths with fist / golden tree / flame holograms.

## Files
- `index.html`: landing page. Hero tile (`arcade`), the three featured game pages, top 20 picks,
  platforms, "what to look for", the full searchable library, sources.
- `tekken-8.html`, `elden-ring.html`, `diablo-3.html`: one woven tile each (`tekken`, `elden`,
  `diablo`), why the game works in 3D, how to play it in 3D, related games.
- `games.js`: snapshot of Acer's TrueGame feed (`https://dwujsh8f5c6wo.cloudfront.net/api/trusgame/game/list`,
  the JSON behind spatiallabs.acer.com/truegame/list). Regenerate it from that feed and bump
  `SNAPSHOT`; one entry per game, modes merged, demos/trials dropped.
- `library.js`: keeps only TrueGame's 3D Ultra profiles (the SR stereo ones; 3D+ is an older depth mode and is left out), adds Odyssey 3D Hub titles (Samsung publishes no list, so only the names it has announced),
  the editor's `PICKS`, and rendering for the picks grid and library table.
- `scenes.js`: the four three.js dioramas. `app.js`: inline-3D wiring, the same Tile pattern as
  `leia-spatial/app.js` (read that app's CLAUDE.md for the woven-canvas rules it follows).

## Rules
- The scenes are original low-poly tributes. Never add game art, logos, screenshots or footage.
  We can't host the games themselves; "hosted" here means guide pages and tribute scenes.
- Only claim 3D support that a source shows (Acer's feed, or Samsung's announcements). As of the
  2026-10-20 snapshot Diablo II: Resurrected and Diablo IV have no profile. Diablo III does.
- Point sizes in `THREE.PointsMaterial` are in metres (the scene root is scaled by `S`), so leaves
  use `size: 0.01`, not scene units.
- Reddit blocks our crawler, so community input came from press and forum coverage.
- The user asked for the guide to be framed around **the Leia SR runtime only** (2026-10-20). Acer
  TrueGame and Samsung's Odyssey 3D Hub are described as launchers that ship SR profiles, not as
  separate platforms. Tags read "Leia SR" plus "via TrueGame" / "via Odyssey 3D Hub".
