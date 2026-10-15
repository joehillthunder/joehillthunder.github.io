# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The GitHub Pages **user site** for `joehillthunder` (https://joehillthunder.github.io/): a hub of web
demos for glasses-free 3D (Leia) displays built on the DisplayXR inline-3D web SDK. Every page runs in
2D in any browser and in 3D in the DisplayXR Browser on a 3D display.

- **No build, no package install, no CI.** Plain ES modules, with three.js loaded through each page's
  `<script type="importmap">`.
- **Pages builds from `main`, path `/`, in legacy (Jekyll) mode.** Merging to `main` publishes the
  site within a minute or two. Jekyll skips files and folders whose names start with `_` or `.`.
- Work goes through a branch and a PR, merged with a merge commit. Commit subjects start with the
  area they touch (`home: …`, `energy-grid: …`, `sugar-rush: …`).

## Running and checking

Serve the **repo root** with any static server. Pages use root-relative paths and import from sibling
folders, so serving a subfolder breaks them:

```sh
python -m http.server 8000      # then http://localhost:8000/
```

- **3D:** open the page in the DisplayXR Browser on a machine with a Leia display. On the demo PC
  that is `C:\Program Files\DisplayXR\Browser\chrome.exe`. A screenshot of a woven canvas comes out
  black; read the canvas itself (`canvas.toDataURL()`, which needs `preserveDrawingBuffer`) to see
  the side-by-side pair.
- **There are no repo-level tests.** QA goes through query flags:
  - homepage: `?mono` forces the flat view; `?depth=<0.05–1>` sets the building's depth;
  - Sugar Rush: `?dev` (fps counter and test hook), `?start`, `?at=<platform>`, and
    `?simulate=<seconds>`, needed because headless Chrome does not advance the animation loop.
- `displayxr-demos/` is an npm-workspaces monorepo with its own rules and per-app READMEs.

## Architecture

### Homepage: "DisplayXR HQ" (`index.html`, `home/`)

An isometric voxel office where each demo is a room.

- `home/demos.js` exports `WINGS` and is the **single source** for both the 3D office
  (`home/office.js`) and the card directory below it (inline script in `index.html`). Adding a demo
  means adding one entry, with `id`, `name`, `desc`, `url`, `source` and `chatter`.
- **There must be exactly four wings.** `office.js` maps them one-to-one onto four floor quadrants
  (`QUADS`). Add demos to an existing wing; add a wing only by replacing one.
- A demo's room can have a set piece in `BUILD[demo.id]` in `office.js`. Without one the room only
  gets desks and a plant. Renaming a demo `id` silently drops its set piece.
- The office renders flat with HTML labels, or as one woven inline-3D scene with the labels as depth
  sprites. People, their errands and their chat bubbles are generated in `office.js`.

### Where demos live

- **In this repo:** `stereo-splat/`, `sugar-rush/`, and the apps under `displayxr-demos/apps/`.
- **In their own repos:** most demos (`displayxr-aviation-coach`, `displayxr-muse-voice`,
  `displayxr-dot-voice`, `displayxr-battleship`, …), published as Pages project sites on the same
  domain. That is why `demos.js` links them with bare relative URLs such as `displayxr-muse-voice/`.
  Changes to those demos belong in their repos, not here.
- **A demo that moves out** leaves a redirect stub here: an `index.html` with a meta refresh and
  `location.replace`, as in `displayxr-demos/apps/battleship/`.

### DisplayXR SDK (`@displayxr/inline3d`)

- It is **vendored per site** with a `VERSION` file, because jsDelivr has returned 503 for some SDK
  modules. Versions differ: `home/vendor/inline3d` is 1.45.1, and
  `stereo-splat/vendor/inline3d` and `displayxr-demos/apps/energy-grid/vendor/inline3d` are 1.37.1.
- **`sugar-rush` imports the copy in `../stereo-splat/vendor/inline3d`.** Don't move, upgrade or prune
  that copy without checking Sugar Rush.
- Before writing or changing anything that hosts a woven canvas, read
  `DisplayXR/displayxr-web` → `docs/woven-canvas-rules.md` and the `.d.ts` files at that repo's root.
  Never guess SDK APIs. The rules every page here follows:
  - one `createInline3D()` per document;
  - never remount a woven canvas; size its 2:1 backing store before `addScene`;
  - keep an opaque cover on top until `handle.firstWoven`, and again across a resize until
    `handle.rewoven()`;
  - check for two views and a viewport per eye **before** clearing, and replay the last good frame
    otherwise;
  - no `filter`, `opacity`, `border-radius` or other effects on the canvas or its ancestors, and no
    `backdrop-filter` on anything drawn over it;
  - overlays smaller than the tile, marked `data-inline3d-overlay`;
  - for a subject the user turns (an avatar, a model, a diorama), a display rig (`virtualDisplayHeight`,
    0.24 m by default). `+z` is out of the glass.

### `displayxr-demos/`

Read `displayxr-demos/CLAUDE.md` before working there. In short:
- one branch per app (`app/<name>`), and edit only your own app's folder;
- changes to `packages/` go in as a note in `CHANGES-NEEDED.md`;
- every app runs in mock mode with no keys, and new keys get an empty entry in `.env.example`;
- every committed asset needs a row in `assets/LICENSES.md` (CC0, CC-BY or user-supplied).

`packages/core`, `packages/importer` and several apps (`agent-voice`, `aviation-coach`,
`playground-port`, `world-gen`) are README-only placeholders.
