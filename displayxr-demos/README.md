# displayxr-demos

Web demos for glasses-free 3D displays, built on the DisplayXR inline-3D SDK
([`@displayxr/inline3d`](https://github.com/DisplayXR/displayxr-web)). Every app runs in mock mode with no
API keys, and in 2D in any browser. On the DisplayXR Browser with a 3D display, it runs in 3D.

Rules for anyone working here, people or agents: [`CLAUDE.md`](CLAUDE.md).

It lives in the `displayxr-demos/` folder of [`joehillthunder.github.io`](https://github.com/joehillthunder/joehillthunder.github.io)
and is published by GitHub Pages at https://joehillthunder.github.io/displayxr-demos/, so everything here is
public. Keys stay in `.env`, which is never committed.

## Apps

| App | What | Status |
|---|---|---|
| [Energy Grid](https://joehillthunder.github.io/displayxr-demos/apps/energy-grid/) (`apps/energy-grid`) | Future Grids Training: a digital twin of a 12.47 kV distribution grid and microgrid with live AC power flow, a storm-restoration exercise, a substation twin and a one-year what-if sweep | live |
| [Music Visualizer](https://joehillthunder.github.io/displayxr-demos/apps/music-visualizer/) (`apps/music-visualizer`) | Beat-reactive visuals whose depth pulses with the music | live |
| [Battleship 3D](https://joehillthunder.github.io/displayxr-demos/apps/battleship/) (`apps/battleship`) | Two-player Battleship at sea (pass and play, online, vs computer) with missiles, explosions and sinking ships out of the screen | live |
| `apps/agent-voice` | Muse, Dot, Claude voice demo | not started |
| `apps/aviation-coach` | | not started |
| `apps/playground-port` | | not started |
| `apps/world-gen` | World Labs Marble | not started |

## Packages

| Path | What | Status |
|---|---|---|
| `packages/core` | Display page, WebSocket bridge, agent adapters | not started |
| `packages/importer` | `dxr-import`: Sketchfab, KitBash, Smithsonian | not started |

## Setup

```sh
npm install          # npm workspaces: packages/* and apps/*
cp .env.example .env # optional; without keys every app runs in mock mode
```
