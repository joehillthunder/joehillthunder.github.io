# energy-grid — Future Grids Training

An interactive grid-operations trainer for new utility engineers. A digital twin of a 12.47 kV
distribution grid with a microgrid (solar, battery, critical loads) runs a real AC power flow ten
times a second. On a glasses-free 3D display, opened in the
[DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser), the grid is a 3D diorama; in any
other browser it renders in 2D.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/energy-grid/

Static files only: no build, no keys, no server. Rules: [`../../CLAUDE.md`](../../CLAUDE.md). Branch: `app/energy-grid`.

## What you can do

| | |
|---|---|
| **Storm restoration** (≈3 min) | Lightning faults Feeder 1. The breaker trips, fault indicators flag, the microgrid islands on its battery. Find the fault, isolate it, restore through the tie, then reconnect the microgrid and discharge the battery to relieve the overloaded feeder. Mistakes behave like the real thing (closing into a fault trips the breaker). Score card at the end. |
| **Explore** | Tap any equipment (3D view or one-line diagram) for what it is, what it does and live values. Operate breakers and switches, dispatch the battery. |
| **Substation twin** | Drill into the substation: transformer, HV breaker, disconnects, CTs/VTs, bus, relay house, feeder breakers. |
| **What-if: one year** | Fails every element under 8,760 hourly conditions, then restores what it can: ~158,000 AC power flows across all CPU cores (Web Workers). Risk shows as purple bars on the map. |

Mouse/touch: drag to turn, wheel or pinch to zoom, tap to select, double-tap the substation for the twin.
Keys: <kbd>1</kbd> map, <kbd>2</kbd> twin, <kbd>3</kbd> what-if, <kbd>S</kbd> start the storm, <kbd>R</kbd> reset.
After 60 s idle it runs an attract loop.

URL flags: `?mono` forces the flat renderer; `?attract=N` sets the idle timeout (s); `?view=twin`;
`?select=<id>`; `?start=storm|whatif`.

## How it works

- `js/sim/powerflow.js` — balanced per-unit AC power flow: nodal admittance matrix, constant-power
  loads (constant-impedance below 0.6 pu), Norton sources, fixed-point current injection. Handles
  meshes, islands and faults. About 0.07 ms per solve.
- `js/sim/simcore.js` — clock, protection (overcurrent trips, fault indicators, PCC loss-of-voltage
  islanding), alarms, battery state of charge, the storm scenario and its scoring.
- `js/sim/whatif-worker.js` + `local-backend.js` — the contingency sweep, split across workers.
- `js/scene.js` (grid map), `js/twin.js` (substation), `js/oneline.js` (live SVG one-line).
- `js/app.js` — one persistent woven canvas via `@displayxr/inline3d` `addScene` on a **display rig**:
  the diorama is the subject and the user turns it under a fixed portal. The canvas stays bare
  (no CSS border/background/filter) and is covered until `handle.firstWoven`.
- `data/network.json` — the network and the equipment explanations.

`js/api.js` looks for a local simulation server at `api/` first and uses it when present (a
separate desktop build backs it with EPRI's open-source OpenDSS); on GitHub Pages there is none,
so everything runs in the page. `?local` forces the in-page engine.

Design: ISA-101 control-room style. Grey is normal, colour means attention: red = trip/fault/
customers out, orange = overload, yellow = abnormal state or near a limit, cyan = power flow,
purple = what-if risk. Breakers: filled square = closed, hollow = open.

## Needs Leia hardware

Depth comfort of the tilted map, pick accuracy in 3D (picking uses the mid-eye ray), and text
legibility next to the woven canvas. Everything else is verifiable in 2D.

No assets: all geometry is procedural, so nothing to add to `assets/LICENSES.md`.
