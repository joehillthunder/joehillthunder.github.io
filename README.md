# displayxr-demos

Web demos for glasses-free 3D displays, built on the DisplayXR inline-3D SDK
([`@displayxr/inline3d`](https://github.com/DisplayXR/displayxr-web)). Every app runs in mock mode with no
API keys, and in 2D in any browser. On the DisplayXR Browser with a 3D display, it runs in 3D.

Rules for anyone working here, people or agents: [`CLAUDE.md`](CLAUDE.md).

| Path | What | Status |
|---|---|---|
| `packages/core` | Display page, WebSocket bridge, agent adapters | not started |
| `packages/importer` | `dxr-import`: Sketchfab, KitBash, Smithsonian | not started |
| `apps/agent-voice` | Muse, Dot, Claude voice demo | not started |
| `apps/aviation-coach` | | not started |
| `apps/playground-port` | | not started |
| `apps/world-gen` | World Labs Marble | not started |

## Setup

```sh
npm install          # npm workspaces: packages/* and apps/*
cp .env.example .env # optional; without keys every app runs in mock mode
```
