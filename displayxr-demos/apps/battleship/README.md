# Battleship 3D

Two-player Battleship on a golden-hour sea, built for glasses-free 3D with the DisplayXR inline-3D SDK.
On a Leia display in the DisplayXR Browser, missile arcs, fireballs, flying debris, water columns
and the HIT / SUNK banners come out of the screen. In any other browser it plays in 2D.

Live: https://joehillthunder.github.io/displayxr-demos/apps/battleship/

## Modes

| Mode | How it works |
|---|---|
| Pass & Play | Two players on one screen. The boards are wiped while the screen changes hands, and each player watches the shots that landed on their fleet before taking their turn. |
| Online | Two browsers. The host gets a 5-letter room code (or a `?join=CODE` link). The browsers find each other through the free public PeerJS broker, then talk directly over WebRTC. Each side keeps its own fleet and answers shots with hit, miss or sunk. |
| vs Computer | Admiral Byte: Easy (mostly random), Normal (checkerboard hunt), Hard (probability density over every remaining ship placement). |
| Watch | The computer plays both sides and starts a new game after each one. For a demo screen: `?watch`. |

Optional rule: "A hit earns another shot".

## Controls

- Placement: click a square to drop the selected ship, <kbd>R</kbd> or right-click to rotate, click a placed ship to pick it up. Random and Clear are on the bar.
- Battle: move over the enemy grid to aim and click to fire. Arrow keys / WASD move the reticle, <kbd>Enter</kbd> fires. On touch, tap once to aim and again to fire.
- <kbd>M</kbd> mutes. The Depth slider sets how far things come out of and go into the display.

## How it's built

Plain ES modules, no build step. three 0.161 and `@displayxr/inline3d` 1.45.1 from jsDelivr.

| File | What |
|---|---|
| `js/stage.js` | One persistent woven canvas (`addScene`) with a camera rig: eyes attached to the app camera, convergence on the board in view, eye separation scaled with camera distance. 2D fallback loop. |
| `js/ocean.js` | Sky dome with sun and clouds, ocean shader (sum-of-sines swell, sky reflection, sun glitter, foam, haze), and the same wave function on the CPU so ships ride the swell. |
| `js/ships.js` | Procedural warships: lofted hulls with anti-fouling and boot-top colours, turrets, funnels, masts with spinning radar and waving flags, a carrier with a painted flight deck and parked jets, a submarine. |
| `js/board.js` | Holographic grid overlay (shader with per-square tints and a sonar sweep), labels, buoys, hit/miss markers, the aiming reticle. |
| `js/fx.js` | Pooled point-sprite particles (fire, smoke, spray, sparks), missiles with exhaust trails, explosions, splashes, shockwaves, debris, fireworks, floating 3D banners, camera shake. |
| `js/world.js` | Scene, camera moves between the boards, picking, and the strike sequences (turrets swing and fire, missile flies, impact, sinking). |
| `js/game.js` | Rules and the computer opponent. |
| `js/net.js` | PeerJS wrapper for online play. |
| `js/audio.js` | Synthesised sound (Web Audio): launches, whistles, explosions, splashes, sinking hulls, sonar. |
| `js/main.js` | Game flow and UI. |

No image, model or sound files: everything is generated in code, so there is nothing to add to `assets/LICENSES.md`.

Woven-canvas rules followed: one inline-3D session, one canvas that is never remounted, `will-change: transform`
on it from first paint, an opaque cover that is removed (hard cut) on `firstWoven`, and no CSS effects or
`backdrop-filter` on or over the canvas. Dialogs are centred cards, not full-screen backdrops.

## Testing notes

- `window.battleship` exposes `{ G, world }` for DevTools checks.
- Checked in headless Chrome/Edge driven over CDP: a full game vs the computer to victory and rematch,
  a pass-and-play round with the hand-off and incoming replay, and three online rounds between two
  browsers (with the guest firing the moment its turn starts).
- Not yet checked on the Leia panel: depth comfort of the missile arcs and banners, and frame rate at 8K.
