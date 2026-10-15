// Every DisplayXR demo on the site, grouped by topic. The office scene and the card list
// below it both read from here, so adding a demo means adding one entry.

export const WINGS = [
  {
    id: 'training',
    name: 'Training Center',
    blurb: 'Hands-on simulators for skilled work, where depth helps people see how things fit together.',
    floor: ['#2c4a63', '#27425a'],
    accent: '#5fb4ff',
    demos: [
      {
        id: 'energy-grid',
        name: 'Energy Grid',
        desc: 'Future Grids Training: restore a storm-damaged 12.47 kV grid with a live substation and microgrid twin.',
        url: 'displayxr-demos/apps/energy-grid/',
        source: 'https://github.com/joehillthunder/joehillthunder.github.io/tree/main/displayxr-demos/apps/energy-grid',
        chatter: ['Breaker 3 tripped. Storm drill!', 'Islanding the microgrid on battery', 'Tie switch closed, Feeder 1 restored', 'Feeder 1 at 104%, dispatch the battery'],
      },
      {
        id: 'aviation',
        name: 'Aviation Coach',
        desc: 'An AI instructor teaches four lessons in 3D: an engine 100-hour inspection, a preflight walk-around, landing gear and brakes, and the flight-control cables.',
        url: 'displayxr-aviation-coach/',
        source: 'https://github.com/joehillthunder/displayxr-aviation-coach',
        chatter: ['Cylinder 3 torque check done', 'Sumped the fuel, no water', 'Brake linings within limits', 'Turnbuckle safety wire OK'],
      },
      {
        id: 'mission-planner',
        name: 'Mission Planner',
        desc: 'ATAK-style mission planning in 3D: plan routes, overwatch and landing zones on an aerial map, fly an ISR drone, walk the ground and switch to thermal or see-through sensors. Six graded missions.',
        url: 'displayxr-mission-planner/',
        source: 'https://github.com/joehillthunder/displayxr-mission-planner',
        chatter: ['Route via the ford, 4% exposed', 'IR shows three warm rooms', 'HLZ slope under 7 degrees', 'Going to ground at Bridge 7'],
      },
    ],
  },
  {
    id: 'ai',
    name: 'AI Studio',
    blurb: 'Talk to an agent and what it shows you appears on the display in real depth.',
    floor: ['#4a3566', '#422f5c'],
    accent: '#c08bff',
    demos: [
      {
        id: 'muse',
        name: 'Muse Voice',
        desc: 'Talk to Muse and 3D content appears on the glasses-free display.',
        url: 'displayxr-muse-voice/',
        source: 'https://github.com/joehillthunder/displayxr-muse-voice',
        chatter: ['Muse, show me a dragon', 'Rendering a koi pond in depth', 'Hey Muse, make it bigger', 'The jellyfish is floating off the glass'],
      },
      {
        id: 'dot',
        name: 'Dot Voice',
        desc: 'Ask an AI agent to show something; it appears in 3D (OpenAI dots, Realtime voice, Claude).',
        url: 'displayxr-dot-voice/',
        source: 'https://github.com/joehillthunder/displayxr-dot-voice',
        chatter: ['Show me the solar system', 'Now a DNA helix, please', 'Claude picked a 3D bar chart', 'Realtime voice is live'],
      },
    ],
  },
  {
    id: 'arcade',
    name: 'Arcade',
    blurb: 'Games where the platforms and pickups pop out of the screen.',
    floor: ['#6a3350', '#5e2d47'],
    accent: '#ff7ab8',
    demos: [
      {
        id: 'sugar-rush',
        name: 'Sugar Rush',
        desc: 'A candy-factory 3D platformer with real depth.',
        url: 'sugar-rush/',
        source: 'https://github.com/joehillthunder/joehillthunder.github.io/tree/main/sugar-rush',
        chatter: ['Gummy bear jump, 37 combo!', 'Careful, the lava is caramel', 'New best on level 4', 'That conveyor belt is brutal'],
      },
      {
        id: 'playground',
        name: 'Playground',
        desc: 'A no-code Playground game rebuilt for glasses-free 3D.',
        url: 'displayxr-playground-port/',
        source: 'https://github.com/joehillthunder/displayxr-playground-port',
        chatter: ['Level 2 ported to 3D', 'That platform really pops', 'Who left the ball pit open?', 'Physics feels right now'],
      },
      {
        id: 'battle-school',
        name: 'Battle School',
        desc: "A game inspired by Ender's Game: zero-g battles in the Battle Room, Ender's command console with the fleet as a hologram, and flying a fighter in the war itself.",
        url: 'displayxr-battle-school/',
        source: 'https://github.com/joehillthunder/displayxr-battle-school',
        chatter: ["The enemy's gate is down", 'Little Doctor away!', 'Bean, take the flank', 'Tab back to the console'],
      },
    ],
  },
  {
    id: 'media',
    name: 'Media & UI Lab',
    blurb: 'Capture, sound and interface experiments for spatial displays.',
    floor: ['#2f5a45', '#2a503d'],
    accent: '#6fe0a4',
    demos: [
      {
        id: 'music',
        name: 'Music Visualizer',
        desc: 'Audio-reactive visuals from Spotify, YouTube or any PC audio, in five styles.',
        url: 'displayxr-music-visualizer/',
        source: 'https://github.com/joehillthunder/displayxr-music-visualizer',
        chatter: ['Switching to synthwave', 'Bass hit, the orb jumped', 'Nebula style on the Spotify feed', 'Lofi mode for focus'],
      },
      {
        id: 'splat',
        name: 'Stereo Splat',
        desc: 'Turn a 3D camera photo into a Gaussian splat you can look around.',
        url: 'stereo-splat/',
        source: 'https://github.com/joehillthunder/joehillthunder.github.io/tree/main/stereo-splat',
        chatter: ['Converting the stereo photo', '2.1M splats and it looks sharp', 'Depth from the 3D camera', 'Orbit it slowly'],
      },
      {
        id: 'buttons',
        name: '3D Buttons',
        desc: 'Web buttons, tiles and a dock that rise out of the glass on hover.',
        url: 'https://azbleia.github.io/ui-samples/',
        source: 'https://github.com/azbleia',
        chatter: ['These buttons rise out of the glass', 'Pop-out or recessed? Pick one', 'Tuning the hover depth', 'Dock icons in real depth'],
      },
    ],
  },
];

export const LOBBY_CHATTER = ['Coffee in the lobby', "Who's demoing next?", 'The Leia panel is warmed up', 'New build just landed', 'Open it in the DisplayXR Browser'];
