// "Physical prompting": the same scene holds two containers and three oranges, and a short
// demonstration (the prompt) says which container to fill and in which order. The prompt is read off
// the demonstration itself (which orange was grasped first, second..., where the first one was let
// go); the pretrained policy then does the motion toward whatever goal the prompt implies. No weights
// change. A small, explainable stand-in for in-context task inference.

import { Targeter, PolicyController } from './policy.js';
import { PLATE_HOME, ORANGE_HOME, ORANGE_R, PLATE_R, mulberry32 } from './task.js';

// Container slots on the counter (USD frame, metres). The expert succeeds at both (measured).
export const SLOTS = [
  { id: 'plate', name: 'Plate', at: [PLATE_HOME[0], PLATE_HOME[1]] },
  { id: 'bowl', name: 'Blue bowl', at: [PLATE_HOME[0], PLATE_HOME[1] - 0.1] },
];

/** Layout for a prompted episode: oranges ±3 cm, the target container at its slot ±3 cm. */
export function promptLayout(rng, slot = 0, spread = 1) {
  const j = () => (rng() * 2 - 1) * 0.03 * spread;
  for (let tries = 0; tries < 80; tries++) {
    const oranges = ORANGE_HOME.map(([x, y]) => [x + j(), y + j()]);
    const plates = SLOTS.map((s) => [s.at[0] + j(), s.at[1] + j()]);
    let ok = true;
    for (let a = 0; a < 3 && ok; a++) for (let b = a + 1; b < 3; b++) if (Math.hypot(oranges[a][0] - oranges[b][0], oranges[a][1] - oranges[b][1]) < 2 * ORANGE_R + 0.008) { ok = false; break; }
    for (const o of oranges) for (const p of plates) if (Math.hypot(o[0] - p[0], o[1] - p[1]) < PLATE_R + ORANGE_R + 0.004) ok = false;
    if (Math.hypot(plates[0][0] - plates[1][0], plates[0][1] - plates[1][1]) < 0.115) ok = false; // containers apart
    if (ok) return { oranges, plate: plates[slot], containers: plates, slot };
  }
  return { oranges: ORANGE_HOME.map((o) => o.slice()), plate: SLOTS[slot].at.slice(), containers: SLOTS.map((s) => s.at.slice()), slot };
}

// Completed orders by first orange: the best-measured completion for each first pick (bake5).
export const FIRST_ORDER = { 0: [0, 1, 2], 1: [1, 2, 0], 2: [2, 1, 0] };

export class PromptTargeter extends Targeter {
  constructor(order = [0, 1, 2]) { super(); this.order = order; }
  pick(env) {
    if (env.held >= 0) this.choice = -1;
    else if (this.choice < 0 || env.onPlate(this.choice)) {
      this.choice = -1;
      for (const i of this.order) if (!env.onPlate(i)) { this.choice = i; break; }
    }
    return this.goalFor(env, env.held >= 0 ? env.held : this.choice);
  }
}

export class PromptedPolicy extends PolicyController {
  constructor(model, prompt, name = 'Prompted policy') {
    super(model, name);
    this.prompt = prompt;
    this.tg = new PromptTargeter(prompt.order);
  }
}

/**
 * Reads a prompt from a demonstration's events (env.events from task.js: grasp / release with
 * orange index and time) and the container positions. Returns { order, slot, evidence }.
 */
export function readPrompt(events, layout, releasePoints) {
  let order = [];
  for (const e of events) if (e.type === 'grasp' && !order.includes(e.orange)) order.push(e.orange);
  const seen = order.length;
  // fewer than three grasps seen: complete the order the way the policy handles best (measured)
  if (seen < 3) order = seen ? FIRST_ORDER[order[0]].slice() : [0, 1, 2];
  let slot = null;
  if (releasePoints.length) {
    const p = releasePoints[0];
    let best = Infinity;
    layout.containers.forEach((c, i) => { const d = Math.hypot(p[0] - c[0], p[1] - c[1]); if (d < best) { best = d; slot = i; } });
  }
  return { order, slot, seen, releases: releasePoints.length };
}

export { mulberry32 };
