// Extra chapters, numbered 3+ after "Prompt it" and "Fleet". Each module exports one object:
//   { id, label, html,            // nav label and the panel section's inner HTML (ids prefixed with the chapter id)
//     init(ctx), enter(ctx), leave(ctx),   // leave() must restore the kitchen view and stop its own loops
//     tick(dt, ctx) -> true when it drew the frame itself (main then skips its kitchen sim/draw/HUD),
//     keydown(e, ctx) -> true when handled, keyup(e, ctx) }
// ctx is defined at the bottom of main.js.
import rollouts from './ch-rollouts.js';
import teleop3d from './ch-teleop.js';
import pointcloud from './ch-pointcloud.js';
import handover from './ch-handover.js';

export const CHAPTERS = [rollouts, teleop3d, pointcloud, handover];
