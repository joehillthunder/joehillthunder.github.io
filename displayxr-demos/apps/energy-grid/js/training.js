// Site training: self-guided courses inside the substation twin, after the use cases EPRI's member
// utilities named for its VR Substation (transmission.epri.com/mts): virtual site tours, contractor
// orientation on limits of approach and hazard awareness, and pre-job briefings that show
// energized equipment and the work zone.
//
// A course is a list of steps:
//   stop  fly the camera to `item`, select it, show the narration
//   quiz  multiple choice; `answer` is the index of the right option, `why` explains it
//   find  tap every item in `targets` in the 3D view; anything in `wrong` counts as a mistake
// `show` on a course turns on the twin's training overlays (see SubstationTwin.setTraining).
// `switching` is a list of [device, close] operations run on the live simulator at the start.

// Limits of approach for unqualified persons, OSHA 29 CFR 1910.333(c)(3): 10 ft up to 50 kV to
// ground, plus 4 in for every 10 kV over that (partial steps rounded up, the conservative reading).
// Phase-to-ground: 115 kV / sqrt(3) = 66.4 kV; 12.47 kV / sqrt(3) = 7.2 kV.
export const MAD = {
  hv: { kv: 115, ft: '10 ft 8 in', m: 3.25 },
  lv: { kv: 12.47, ft: '10 ft', m: 3.05 },
};

export const COURSES = [
  {
    id: 'tour',
    title: 'Virtual site tour',
    blurb: 'Walk the yard along the path power takes, from the 115 kV line to the feeders. About 4 minutes.',
    show: {},
    steps: [
      { type: 'stop', item: 'twin_fence', title: 'Before you enter', zoom: 1.2,
        body: 'Every entry needs authorization, a briefing on what is energized, and PPE: hard hat, safety glasses, FR clothing, safety-toe boots. Read the signs at the gate. Everything inside the fence is treated as energized until proven otherwise.' },
      { type: 'stop', item: 'twin_line', title: 'Incoming 115 kV line',
        body: 'The transmission line lands on a lattice dead-end structure. Its horizontal insulator strings take the full pull of the conductors. Power enters the yard here.' },
      { type: 'stop', item: 'twin_arrester', title: 'Surge arresters',
        body: 'The first device the line meets. Arresters send lightning and switching surges to ground before they reach the transformer. Look for the copper ground lead at each base.' },
      { type: 'stop', item: 'twin_ds', title: 'Disconnect switch',
        body: 'A visible air gap. Crews open it only after the breaker has interrupted the current, then confirm the gap by eye before any work downstream.' },
      { type: 'stop', item: 'twin_hvbkr', title: 'SF6 dead-tank breaker',
        body: 'Interrupts 115 kV fault current inside grounded, gas-filled tanks. Check the gas-pressure gauge on the mechanism cabinet during your walk-down.' },
      { type: 'stop', item: 'twin_ct', title: 'Instrument transformers',
        body: 'CTs and VTs give the relays a scaled copy of the current and voltage. If the relays cannot measure, nothing trips. Never open a CT secondary under load.' },
      { type: 'stop', item: 'twin_xfmr', title: 'Power transformer', zoom: 2.1,
        body: 'Steps 115 kV down to 12.47 kV. Find the radiators and fans (cooling), the conservator (oil expansion), the breather, the load tap changer cabinet and the concrete oil-containment curb.' },
      { type: 'stop', item: 'twin_bus', title: '12.47 kV bus',
        body: 'Rigid tubes on post insulators carry power to every feeder breaker. The whole bus is one energized zone: a fault here takes out every feeder.' },
      { type: 'stop', item: 'twin_f1', title: 'Feeder switchgear',
        body: 'Metal-clad cubicles hold the feeder breakers. Read the lamps before anything else: RED lit = breaker closed (circuit live), GREEN lit = open. Feeders leave underground to riser poles outside the fence.' },
      { type: 'stop', item: 'twin_cap', title: 'Capacitor bank',
        body: 'Supports voltage at peak load. Capacitors store energy after they are switched off: wait the discharge time, then ground them, before anyone touches them.' },
      { type: 'stop', item: 'twin_relay', title: 'Control house',
        body: 'Protective relays, the SCADA RTU and the station battery. Control cables run out to every device through the concrete cable trench you have been stepping over.' },
      { type: 'stop', item: 'twin_mast', title: 'Shield masts and ground grid', zoom: 1.4,
        body: 'Masts catch lightning. The buried copper grid bonds every structure and the fence so touch and step voltages stay safe during a fault. Report any cut or loose ground lead and never touch it.' },
    ],
  },
  {
    id: 'contractor',
    title: 'Contractor orientation',
    blurb: 'Limits of approach and hazard awareness for vegetation, animal-abatement and civil crews. Pink shells show how close an unqualified person may come.',
    show: { approach: true, person: true },
    steps: [
      { type: 'stop', item: 'twin_fence', title: 'Limits of approach', zoom: 1,
        body: `The pink shells are the minimum approach distance for unqualified persons (OSHA 1910.333): ${MAD.hv.ft} (${MAD.hv.m} m) from 115 kV parts and ${MAD.lv.ft} (${MAD.lv.m} m) from 12.47 kV parts. That includes tools, ladders, poles and anything else you carry. The figure at the gate is 1.8 m tall for scale.` },
      { type: 'stop', item: 'twin_xfmr', title: 'Look up as well as around', zoom: 1.7,
        body: 'The shells reach above head height. Energized parts sit high on insulators, so a raised trimmer pole or a dump-truck bed can enter the boundary while your feet are well clear.' },
      { type: 'quiz', title: 'Vegetation crew',
        q: 'Your crew is clearing weeds along the inside of the fence near the feeder risers. Where may they work?',
        options: ['Outside the pink shells, with tools and poles kept outside too', 'Anywhere on the gravel: the equipment is insulated', 'Inside a shell if they wear rubber gloves'],
        answer: 0, why: 'Insulators keep the voltage on the conductor, not off you. Unqualified workers and everything they hold stay outside the approach distance; gloves do not change that.' },
      { type: 'quiz', title: 'Animal abatement',
        q: 'You spot a bird nest on top of a 12.47 kV bus stand. What do you do?',
        options: ['Knock it down with a long pole', 'Stop, stay clear and report it to the station owner', 'Climb the stand while the bus is lightly loaded'],
        answer: 1, why: 'Only qualified workers remove it, with the bus de-energized or with live-line tools. Animals and nests are a leading cause of substation faults, and a pole would put you inside the boundary.' },
      { type: 'quiz', title: 'Stored energy',
        q: 'Which equipment can still shock you after it has been switched off?',
        options: ['The fence', 'The capacitor bank', 'The cable trench covers'],
        answer: 1, why: 'Capacitors hold charge after they are disconnected. Wait out the discharge time, then ground them, and leave that to qualified crews.' },
      { type: 'quiz', title: 'Ground connections',
        q: 'You find a ground lead cut off a fence post. What now?',
        options: ['Reattach it with tape', 'Leave it, it is only the fence', 'Do not touch it or the post; mark the spot and report it'],
        answer: 2, why: 'The fence is bonded to the ground grid. Without that bond, a fault in the yard can put a dangerous voltage on the fence and the cut lead.' },
      { type: 'quiz', title: 'Reading the switchgear',
        q: 'A lamp on a feeder cubicle is lit RED. What does it mean?',
        options: ['The breaker is closed and the feeder is live', 'The breaker has tripped and is safe', 'There is a fault alarm'],
        answer: 0, why: 'Utility field convention: RED = closed (energized), GREEN = open. It is the reverse of most industrial controls, so contractors often get it wrong.' },
    ],
  },
  {
    id: 'briefing',
    title: 'Pre-job briefing',
    blurb: 'Walk a maintenance crew through Feeder 2 breaker work: what is isolated, what stays energized, and the steps before anyone touches it.',
    show: { briefing: true, person: true },
    // Real switching in the simulator, undone in reverse when the course ends.
    switching: [['TIE', true], ['BKR_F2', false]],
    steps: [
      { type: 'stop', item: 'twin_f2', title: 'The job: Feeder 2 breaker maintenance', zoom: 1.8,
        body: 'Feeder 2 is switched out and its customers carried on the tie. The green box is the work zone: the Feeder 2 breaker cubicle and its cable riser. Red boxes are equipment that stays energized next to the crew.' },
      { type: 'find', title: 'Hazard hunt', zoom: 1.3,
        body: 'Tap every piece of equipment that stays ENERGIZED while the crew works on Feeder 2. Red boxes are a hint; switch them off in your head and use the lamps.',
        targets: ['twin_bus', 'twin_f1', 'twin_cap', 'twin_xfmr'],
        wrong: { twin_f2: 'Feeder 2 is the work zone: open, racked out and grounded before work starts.' } },
      { type: 'quiz', title: 'Isolation',
        q: 'The Feeder 2 breaker is open and its GREEN lamp is lit. Can the crew start work?',
        options: ['Yes: green means it is safe', 'No: rack it out, lock and tag it, test for absence of voltage, then apply grounds', 'Yes, once the control center confirms on the phone'],
        answer: 1, why: 'Open is not isolated. Rack out, lock and tag, test before touch, and ground: the feeder cable can be backfed through the tie or by a customer generator.' },
      { type: 'quiz', title: 'Neighbouring hazards',
        q: 'Feeder 1 is right next to the work zone and stays energized. What goes in the briefing?',
        options: ['Nothing: it is a different feeder', 'Mark the boundary to Feeder 1 with barriers and name the energized parts out loud', 'Open Feeder 1 too, without telling the control center'],
        answer: 1, why: 'Every pre-job briefing names the energized parts near the work, sets up barriers, and assigns someone to watch the boundary. Switching is only done on the control center\'s orders.' },
      { type: 'stop', item: 'twin_relay', title: 'Close out', zoom: 1.4,
        body: 'Before re-energizing: tools and people out, grounds off and counted, tags cleared by the people who hung them, then the control center closes the breaker. Watch the lamp turn RED.' },
    ],
  },
];

export const courseById = (id) => COURSES.find((c) => c.id === id) || null;
