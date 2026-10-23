# EPRI VR Substation on DisplayXR

EPRI's [Virtual Reality Substation](https://transmission.epri.com/mts/) (phase 1) is a member-only,
headset-first training app: a digital twin of a live substation with a self-guided mode and a
multi-user mode. Its build and source are not public, so it cannot be ported directly. This app
brings the same training to a glasses-free 3D display instead: the substation twin in Energy Grid
runs as a woven `@displayxr/inline3d` scene in the DisplayXR Browser (Leia SR displays) and in 2D in
any other browser. No headset, no install.

**Try it:** `…/displayxr-demos/apps/energy-grid/?view=twin`, then **Site training** in the Mission panel,
or go straight to a course with `?course=tour`, `?course=contractor` or `?course=briefing`.

## EPRI's use cases and where they live here

| EPRI VR Substation | Energy Grid on DisplayXR |
|---|---|
| Interactive digital twin of a live substation | The 115/12.47 kV substation twin (`js/twin.js`), driven by a live AC power flow: bus colour, breaker lamps, fan speed and current labels follow the simulation. |
| Self-guided training mode | **Site training** (`js/training.js`): three step-by-step courses with Back/Next (or <kbd>←</kbd> <kbd>→</kbd>), quizzes and a score at the end. |
| Virtual site tours (corporate, engineering, planning staff); recruitment and outreach | **Virtual site tour**: 12 stops from the fence and incoming line to the feeders, control house and ground grid. The camera slides each piece of equipment to the centre of the 3D view. |
| Contractor orientation: limits of approach, safety protocols, hazard awareness for vegetation management and animal abatement | **Contractor orientation**: pink 3D shells show the minimum approach distance for unqualified persons around every exposed energized part, with a 1.8 m worker at the gate for scale. Five scenario questions cover vegetation crews, nests on the bus, stored energy in capacitors, cut ground leads and the RED = closed lamp convention. |
| Pre-job briefings: walkthroughs that highlight energized equipment and work zones | **Pre-job briefing** for Feeder 2 breaker maintenance. The simulator really closes the tie and opens BKR-F2, so the F2 lamp turns green and its customers stay on through Feeder 1. A green box marks the work zone and red boxes mark what stays energized. The trainee taps every energized hazard (a hazard hunt), answers isolation/LOTO questions, and Feeder 2 is switched back in at the end. |
| Multi-user session mode, spectator app | Not built (see below). |
| Future: 1-line diagram, real-time simulation | Already here: a live one-line diagram and a 10 Hz AC power flow; the invisible layers (<kbd>L</kbd>) add current, voltage, fault current, energized zones and protection. |

## Limits of approach

Unqualified persons, OSHA 29 CFR 1910.333(c)(3): 10 ft for 50 kV or less to ground, plus 4 in for
every 10 kV over that. Partial steps are rounded up (the conservative reading).

| System | Phase-to-ground | Distance |
|---|---|---|
| 115 kV | 66.4 kV | 10 ft 8 in (3.25 m) |
| 12.47 kV | 7.2 kV | 10 ft (3.05 m) |

The model is about 30 m per unit (the 0.07-unit fence is a 7 ft fence), and the shells are drawn at
that scale. Each utility's own rules can be stricter; this is a training aid, not a safety standard.

## What it needs from the display

- Depth comfort of the shells and labels at **Eye level**, and of the tour's zoomed stops (zoom 1.9–2.1).
- Pick accuracy for the hazard hunt in 3D: picking uses the mid-eye ray.
- Everything else (courses, quizzes, switching, scoring) was checked in 2D: a headless click-through
  of all three courses with no script errors, Feeder 2 transferred and restored with 0 customers out.

## Open questions

- **Multi-user / instructor mode.** A shared session (an instructor steps the course and the trainees'
  displays follow) would need a small sync service; the HQ artifact runtime or a WebSocket bridge in
  `packages/core` are candidates.
- **EPRI's own content.** If EPRI shares its substation model or scenario scripts, the courses are
  data (`js/training.js`) and a glTF yard could replace the procedural one.
- More substations (breaker-and-a-half, GIS), and switching orders written by the trainee instead of
  run for them.
