# Sugar Rush

**A magical chocolate-factory platformer that pops out of the screen: real depth on glasses-free 3D
displays, and plain 3D in any browser.**

Play: https://joehillthunder.github.io/sugar-rush/

_Gameplay GIF placeholder: to be recorded on a Leia display._

## How to play

Run and jump through the factory, gathering sweets for points, and hunt the **5 rare Golden
Tickets** hidden just off the path. **Three tickets open the Golden Gate** at the Grand Chocolate
Fountain; find all five for a Perfect bonus.

| Section | What's there |
|---|---|
| Fondant Foyer | Marble start plaza, your first trail of sweets |
| Chocolate River | Drifting wafer rafts, a gummy pad up to a giant lollipop. Fall in and you lose a life |
| Conveyor Hall | A belt that runs back at you, a spinning whisk, a side belt to a ticket |
| Wafer Bridge | Tiles crumble a moment after you land; a ticket waits on a ledge below |
| Gumdrop Gardens | Gumdrop hills, a gummy launch, bouncy cotton-candy clouds |
| Kettle Tower | Copper kettles with timed steam vents; a ticket on top of a chimney |
| Grand Chocolate Fountain | The Golden Gate: bring 3 tickets |

| | Keyboard / mouse | Gamepad | Touch |
|---|---|---|---|
| Move | WASD / arrows | left stick / d-pad | left stick on screen |
| Jump | Space / left click | A | JUMP |
| Fizzy Dash | Shift / right click | X / RB / RT | DASH |
| Pause | Esc / P | Start | Pause button |

**Blueberries:** three glowing blueberries hide just off the path (on a candy beside the foyer, over
the river by the Wafer Bridge, beside the first kettle). Grab one and a blueberry bubble flies you
further along the factory: to the Conveyor Hall, the Kettle Tower, or the fountain plaza. It's a
shortcut with a price: you skip that stretch's sweets and its Golden Ticket.

**Scoring:** blueberry 100, wrapped candy 10, lollipop 25, truffle 50. Chain sweets within 1.6 s for a combo of up to
×5. Golden Ticket 500. At the gate: a time bonus, 250 per life left, and 2,000 for all five tickets.
Lollipop flags are checkpoints. Lives: Easy 5, Normal 3, Hard 2 (Hard also speeds up hazards). Your high
score and best time are saved in this browser.

## How depth is used

The player sits on the screen plane, the factory recedes behind it, and sweet and ticket sparkles and
gummy-pad launches come toward you. The full depth map is in [`DESIGN.md`](DESIGN.md).

On a 3D display a **Depth** slider (0–200%, keys <kbd>[</kbd> <kbd>]</kbd>, remembered per browser) scales
the camera rig's eye separation. The player stays on the screen plane at any setting.

## Hardware

- **For 3D:** a Leia SR glasses-free 3D display, on Windows, with the DisplayXR runtime and the
  [DisplayXR Browser](https://displayxr.org/browser).
- **Anywhere else:** any modern browser plays it in 2D.

## From no-code prompt to glasses-free 3D game

1. **Prompt:** the game was designed by prompting Google Labs Playground ("Sugarworks Rush").
2. **Rebuild:** it was rebuilt from scratch from that design, with new code, shapes and synthesised
   sounds. Nothing was exported from Playground.
3. **Depth:** a depth map was agreed first (`DESIGN.md`), then built with the DisplayXR web SDK's
   camera rig. The runtime turns the follow camera into a 3D pair, with the player on the screen plane.
4. **Chocolate factory:** a later pass rebuilt the world at high fidelity: canvas-drawn textures,
   shadows, new mechanics, sweets and Golden Tickets.

## Developer notes

- Plain ES modules, no build: `main.js` (game, physics, camera, 3D wiring), `world.js` (the course and
  set), `player.js` (the animated candy apprentice), `textures.js` (every texture, drawn on canvases),
  `input.js` (keyboard, mouse, touch, gamepad), `sfx.js` (Web Audio).
- `?dev` shows an fps counter and exposes a test hook. `?start` skips the title; `?at=<n>` starts
  the run on platform `n` of the course; `?simulate=<s>` then runs the game `s` seconds with no input
  before the first frame (for screenshots and QA: headless Chrome does not advance the animation loop).
- Agent hook: `window.sugarRush.start_game(difficulty)`, `.set_difficulty('easy'|'normal'|'hard')`
  and `.show_score()`. These are not on a network bridge yet.
- Three.js 0.180.0 from jsDelivr. The DisplayXR SDK is the copy vendored for Stereo Splat
  (`../stereo-splat/vendor/inline3d`, 1.37.1).
- Assets: none. Every shape and texture is built in code and every sound is synthesised.
