# DisplayXR demos — rules for all agents

- Read github.com/DisplayXR/displayxr-web docs before using @displayxr/inline3d. Never guess APIs.
- Shared code lives in packages/. Apps import it; never copy it.
- Only edit your assigned app folder. To change packages/, open a note in CHANGES-NEEDED.md instead.
- Every app runs in mock mode with no keys and in 2D in any browser.
- Secrets in .env only. Assets need a license entry in assets/LICENSES.md (CC0, CC-BY, or user-supplied only).
- Small commits, one branch per app: app/<name>.
- Finish with: what works, what needs Leia hardware, open questions.

## Layout

```
displayxr-demos/
  CLAUDE.md            ← rules every agent reads (this file)
  CHANGES-NEEDED.md    ← requested changes to packages/, one note per request
  assets/LICENSES.md   ← one entry per asset
  .env.example         ← every key any app reads; copy to .env (never committed)
  packages/core/       ← display page, WebSocket bridge, agent adapters
  packages/importer/   ← dxr-import (Sketchfab, KitBash, Smithsonian)
  apps/agent-voice/    ← Muse, Dot, Claude voice demo
  apps/aviation-coach/
  apps/playground-port/
  apps/world-gen/      ← World Labs Marble
```

## Where the SDK rules live

The inline-3D page rules that cause most "3D is broken" reports are in
`DisplayXR/displayxr-web` → `docs/woven-canvas-rules.md` (one session per document, never remount
a woven canvas, cover until `firstWoven`, no CSS effects on a woven canvas or its ancestors). Read it
before writing any page that hosts a woven canvas. API: the `.d.ts` files at that repo's root.
