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
| **Substation twin** | A site walk-through of a 115/12.47 kV substation: dead-end structure, surge arresters, disconnect, SF6 dead-tank breaker, CTs/VTs, power transformer (radiators, fans that follow load, conservator, load tap changer), bus, metal-clad switchgear with field-convention lamps (red = closed, green = open), feeder risers, capacitor bank, control house and cable trench, shield masts, grounded fence and signage. |
| **Site training** | Three self-guided courses in the substation twin, after the use cases on [EPRI's VR Substation](https://transmission.epri.com/mts/) (details: [`EPRI-VR-SUBSTATION.md`](EPRI-VR-SUBSTATION.md)): a **virtual site tour** (12 stops along the power path, camera flies to each), **contractor orientation** (3D limits-of-approach shells per OSHA 1910.333, a 1.8 m worker for scale, a 5-question hazard quiz) and a **pre-job briefing** for Feeder 2 breaker work (the sim really transfers Feeder 2 to the tie and opens BKR-F2; work zone vs energized boxes; tap-to-find hazard hunt; LOTO quiz; Feeder 2 switched back in at the end). |
| **Microgrid yard** | The campus microgrid at the end of Feeder 1, driven live: PCC recloser on the utility pole, microgrid switchgear, pad-mount step-up transformers, inverters (PCS), battery containers (one open, with rack LEDs showing state of charge), carport solar, controller with an island beacon, the hospital and its standby generator. Cyan particles show where power flows. |
| **What-if: one year** | Fails every element under 8,760 hourly conditions, then restores what it can: ~158,000 AC power flows across all CPU cores (Web Workers). Risk shows as purple bars on the map. |

**Invisible layers** (<kbd>L</kbd>, the **Layers** menu) draw what a trainee cannot see on site, in
every module: power-flow particles; live current and power labels with direction arrows; bus voltage
rings; the fault-current path with the amps each device saw; energized (red) vs isolated (green)
overlays; and each breaker's protection zone and trip setting. The substation adds the CT secondary
current the feeder relay actually measures; the microgrid adds AC vs DC current and island frequency.
**Training** shows all layers; **Test** hides them so trainees work from the real cues only.
`?layers=training|test|default` sets them from the URL.

**Full screen** (<kbd>F</kbd>) makes the 3D view fill the screen. The header, mission and equipment
card, one-line, alarms and KPIs float over it and stay fully interactive; the **Mission** and
**Diagram** tabs hide or show the side panels. `?full` opens in this layout.

Smaller windows reflow instead of squeezing: the header wraps, the side panels keep a readable
minimum width and the KPI strip wraps; below ~1100 px the page stacks (3D view, then panels, then
KPIs) and scrolls, and on a phone it is a single column with the key hints hidden.

Every 3D module has camera presets (**Overview**, **Eye level** for a walk-in view, **Top**) and a
**3D depth** slider (0–200%, remembered per browser). Below 100% the slider lowers eye separation
through the display rig's `ipdFactor`; above 100% it stretches the scene along the viewing axis for
more depth. It applies on a 3D display and is disabled in 2D.

Mouse/touch: drag to turn, wheel or pinch to zoom, tap to select, double-tap the substation or the
microgrid on the map to open its module.
Keys: <kbd>1</kbd> map, <kbd>2</kbd> substation, <kbd>3</kbd> microgrid yard, <kbd>4</kbd> what-if,
<kbd>O</kbd>/<kbd>E</kbd>/<kbd>T</kbd> overview / eye level / top, <kbd>[</kbd> <kbd>]</kbd> depth,
<kbd>L</kbd> layers, <kbd>F</kbd> full screen,
<kbd>S</kbd> start the storm, <kbd>R</kbd> reset. After 60 s idle it runs an attract loop.

URL flags: `?mono` forces the flat renderer; `?attract=N` sets the idle timeout (s); `?view=twin|mg`;
`?select=<id>`; `?start=storm|whatif`; `?course=tour|contractor|briefing` opens a site-training course.
In a course, <kbd>←</kbd> <kbd>→</kbd> step back and forward.

## How it works

- `js/sim/powerflow.js` — balanced per-unit AC power flow: nodal admittance matrix, constant-power
  loads (constant-impedance below 0.6 pu), Norton sources, fixed-point current injection. Handles
  meshes, islands and faults. About 0.07 ms per solve.
- `js/sim/simcore.js` — clock, protection (overcurrent trips, fault indicators, PCC loss-of-voltage
  islanding), alarms, battery state of charge, the storm scenario and its scoring.
- `js/sim/whatif-worker.js` + `local-backend.js` — the contingency sweep, split across workers.
- `js/training.js` — the site-training courses (stops, quizzes, the hazard hunt) and the approach
  distances; `twin.js` draws their overlays (`setTraining`), `app.js` runs them in the Mission panel.
- `js/scene.js` (grid map), `js/twin.js` (substation), `js/microgrid.js` (microgrid yard),
  `js/oneline.js` (live SVG one-line).
- `js/textures.js` draws every texture on a canvas at startup, weathered for realism (yard stone with
  lit tops, shadows, damp patches and weeds; grass blades; concrete with aggregate, cracks and an
  oil-stained transformer pad; galvanized spangle; painted steel with rust runs and seam grime;
  checked pole wood). Colour maps double as bump maps; porcelain is glazed (clear coat). Also: roads, facades with
  window masks, PV cells, corrugated steel, chain-link, safety signs, nameplates); `js/kit.js` holds the
  shared parts (lattice steel, porcelain with sheds, fences, signs). Shadows come from one sun that
  rides on the model; reflections from a generated sky environment.
- `js/app.js` — one persistent woven canvas via `@displayxr/inline3d` `addScene` on a **display rig**:
  the diorama is the subject and the user turns it under a fixed portal. The canvas stays bare
  (no CSS border/background/filter) and is covered until `handle.firstWoven`.
- `data/network.json` — the network and the equipment explanations.
- `vendor/inline3d/` — `@displayxr/inline3d` 1.37.1, served from this site (Apache-2.0, `LICENSE`). Vendored
  because jsDelivr returned 503 for two of its modules (`inline3d-viewer-ease.js`, `inline3d-buffer-limit.js`)
  on 2026-10-14; three.js still comes from jsDelivr.

`js/api.js` looks for a local simulation server at `api/` first and uses it when present (a
separate desktop build backs it with EPRI's open-source OpenDSS); on GitHub Pages there is none,
so everything runs in the page. `?local` forces the in-page engine.

Design: ISA-101 control-room style. Grey is normal, colour means attention: red = trip/fault/
customers out, orange = overload, yellow = abnormal state or near a limit, cyan = power flow,
purple = what-if risk. Breakers: filled square = closed, hollow = open.

## Needs Leia hardware

Depth comfort of the tilted map, pick accuracy in 3D (picking uses the mid-eye ray), and text
legibility next to the woven canvas. The depth slider (both the `ipdFactor` path on browsers with
view-rig support and the stretch fallback) and the comfort of 200% at eye level. Everything else is
verifiable in 2D.

No assets: all geometry and textures are procedural, so nothing to add to `assets/LICENSES.md`.
