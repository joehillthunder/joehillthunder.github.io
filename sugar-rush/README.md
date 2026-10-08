# Sugar Rush

**A candy-factory platformer that pops out of the screen: real depth on glasses-free 3D displays, and
plain 3D in any browser.**

Play: https://joehillthunder.github.io/sugar-rush/

_Gameplay GIF placeholder: to be recorded on a Leia display._

## How to play

Collect all **4 Golden Seals**, then reach the **Grand Sugar Fountain**. Avoid the spinning saws
and rolling gumballs, and don't fall off.

| | Keyboard / mouse | Gamepad | Touch |
|---|---|---|---|
| Move | WASD / arrows | left stick / d-pad | left stick on screen |
| Jump | Space / left click | A | JUMP |
| Fizzy Dash | Shift / right click | X / RB / RT | DASH |
| Pause | Esc / P | Start | Pause button |

Gummy pads launch you high. The dash works once per jump. Each seal is a checkpoint. Lives depend on
difficulty: Easy 5, Normal 3, Hard 2. Your best time is saved in this browser.

## How depth is used

The player sits on the screen plane, the course recedes behind it, and seal sparkles and gummy-pad
launches come toward you. The full depth map table is in [`DESIGN.md`](DESIGN.md).

## Hardware

- **For 3D:** a Leia SR glasses-free 3D display, on Windows, with the DisplayXR runtime and the
  [DisplayXR Browser](https://displayxr.org/browser).
- **Anywhere else:** any modern browser plays it in 2D.

## From no-code prompt to glasses-free 3D game

1. **Prompt:** the game was designed by prompting Google Labs Playground ("Sugarworks Rush").
2. **Rebuild:** it was rebuilt from scratch from that design: same goal, moves and mood, with new
   code, shapes and synthesised sounds. Nothing was exported from Playground.
3. **Depth:** a depth map was agreed first (`DESIGN.md`), then built with the DisplayXR web SDK's
   camera rig. The runtime turns the follow camera into a 3D pair, with the player on the screen plane.

## Developer notes

- Plain ES modules, no build: `main.js` (game, camera, 3D wiring), `world.js` (the course),
  `input.js` (keyboard, mouse, touch, gamepad), `sfx.js` (Web Audio).
- `?dev` shows an fps counter and exposes a test hook.
- Agent hook: `window.sugarRush.start_game(difficulty)`, `.set_difficulty('easy'|'normal'|'hard')`
  and `.show_score()`. These are not on a network bridge yet.
- Three.js 0.180.0 from jsDelivr. The DisplayXR SDK is the copy vendored for Stereo Splat
  (`../stereo-splat/vendor/inline3d`, 1.37.1).
- Assets: none. Every shape is built in code and every sound is synthesised.
