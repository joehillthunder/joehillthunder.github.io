// Which camera is this? A registry of third-party cameras, matched on the device label (and the
// USB vendor:product id Chromium appends to it, e.g. "HD Pro Webcam C920 (046d:082d)").
//
// Why it matters: the metric fit turns the iris size in pixels into a distance, through the focal
// length, so the lens FOV sets the depth scale. A 90° webcam read as 60° puts the caller ~40%
// too far away and stretches the relief. Each profile carries the maker's DIAGONAL FOV (what
// spec sheets quote); `hfovFor` converts it for the stream's real aspect.
//
// Kinds:
//   webcam     an ordinary colour camera (laptop or USB)
//   pro        a USB webcam we know the lens of
//   ptz        an auto-framing camera: digital zoom changes the FOV, so framing should be locked
//   phone      a phone used as a webcam (Continuity Camera, DroidCam, Camo, Iriun, …)
//   capture    an HDMI capture card (DSLR, mirrorless, camcorder): FOV depends on the lens
//   virtual    a software camera (OBS, NVIDIA Broadcast, …): FOV unknown, may be pre-cropped
//   depth-rgb  the colour sensor of a depth camera (RealSense, Kinect, Orbbec)
//   stereo     a side-by-side stereo camera (ZED, ELP 3D, …): the left eye is used
//   depth      a depth or infrared stream: not a picture of the caller, never used
//   ir         a Windows Hello infrared camera: never used
//   eyetracker the Leia display's eye tracker: using it can break the 3D weave

/** Kind → [group label, auto-pick rank (higher wins; < 0 never auto-picked)]. */
export const KINDS = {
  'pro': ['USB webcams', 5],
  'depth-rgb': ['Depth cameras (colour sensor)', 4],
  'stereo': ['Stereo 3D cameras', 4],
  'ptz': ['Auto-framing cameras', 3],
  'webcam': ['Webcams', 2],
  'phone': ['Phones', 2],
  'capture': ['Capture cards', 1],
  'virtual': ['Virtual cameras', 0],
  'depth': ['Not usable (depth / infrared)', -1],
  'ir': ['Not usable (depth / infrared)', -1],
  'eyetracker': ['Leia eye tracker', -2],
};

const D = (dfov) => ({ dfov });
// Order matters: the first match wins, so specific models come before their maker's catch-all,
// and depth/IR streams before the colour stream of the same camera.
const PROFILES = [
  // ---- never usable
  { re: /\bSR Camera\b|eye ?track/i, name: 'Leia eye tracker', kind: 'eyetracker', note: 'The display uses this camera to track your eyes. Opening it here can interrupt the 3D effect.' },
  { re: /RealSense.*\b(Depth|Infrared|IR)\s*$|\bDepth (Camera|Sensor)\b(?!.*RGB)|Kinect.*(Depth|IR)|Azure Kinect Depth|Femto.*(Depth|IR)|Astra.*(Depth|IR)/i, name: 'Depth / infrared stream', kind: 'depth', note: 'A depth or infrared stream, not a colour picture. Choose the same camera\'s RGB stream instead.' },
  { re: /\bIR Camera\b|Infrared|Hello Face|IR Webcam/i, name: 'Infrared camera (Windows Hello)', kind: 'ir', note: 'An infrared face-login camera: grey and low resolution.' },

  // ---- stereo side-by-side
  { re: /\bZED[ -]?X\b|\bZED[ -]?2i\b|\bZED[ -]?2\b|2b03:f880|2b03:f780/i, name: 'Stereolabs ZED 2', kind: 'stereo', hfovEye: 110, res: [2560, 720] },
  { re: /\bZED[ -]?M(ini)?\b|2b03:f681/i, name: 'Stereolabs ZED Mini', kind: 'stereo', hfovEye: 90, res: [2560, 720] },
  { re: /\bZED\b|2b03:f582/i, name: 'Stereolabs ZED', kind: 'stereo', hfovEye: 90, res: [2560, 720] },
  { re: /3D USB Camera|USB 3D Camera|Stereo ?(Vision|Camera)|\bELP\b.*(3D|Stereo)|Synchronized.*Dual/i, name: 'Stereo USB camera', kind: 'stereo', hfovEye: 70, res: [2560, 960] },

  // ---- depth cameras' colour sensors (horizontal FOVs from the data sheets)
  { re: /RealSense.*\bD45\d|8086:0b5c/i, name: 'Intel RealSense D455', kind: 'depth-rgb', hfov: 90 },
  { re: /RealSense.*\bD4\d\d|RealSense.*RGB|8086:0b07|8086:0ad3/i, name: 'Intel RealSense D4xx', kind: 'depth-rgb', hfov: 69 },
  { re: /RealSense/i, name: 'Intel RealSense', kind: 'depth-rgb', hfov: 69 },
  { re: /Azure Kinect|045e:097d/i, name: 'Azure Kinect', kind: 'depth-rgb', hfov: 90 },
  { re: /Kinect|Xbox NUI/i, name: 'Kinect v2', kind: 'depth-rgb', hfov: 84 },
  { re: /Femto/i, name: 'Orbbec Femto', kind: 'depth-rgb', hfov: 80 },
  { re: /Orbbec|Astra|2bc5:/i, name: 'Orbbec Astra', kind: 'depth-rgb', hfov: 66 },

  // ---- auto-framing / PTZ (diagonal FOV at the widest; framing must be locked for true depth)
  { re: /Insta360 Link 2|2e1a:4c04/i, name: 'Insta360 Link 2', kind: 'ptz', ...D(79.5) },
  { re: /Insta360 Link|2e1a:/i, name: 'Insta360 Link', kind: 'ptz', ...D(79.5) },
  { re: /OBSBOT.*Tiny ?2/i, name: 'OBSBOT Tiny 2', kind: 'ptz', ...D(85.5) },
  { re: /OBSBOT.*Meet/i, name: 'OBSBOT Meet', kind: 'ptz', ...D(85.5) },
  { re: /OBSBOT/i, name: 'OBSBOT', kind: 'ptz', ...D(86) },
  { re: /PanaCast 20/i, name: 'Jabra PanaCast 20', kind: 'ptz', ...D(90) },
  { re: /PanaCast/i, name: 'Jabra PanaCast', kind: 'ptz', ...D(120) },
  { re: /Rally|MeetUp|Logi Dock/i, name: 'Logitech conference camera', kind: 'ptz', ...D(90) },
  { re: /Poly Studio|Studio P5/i, name: 'Poly Studio', kind: 'ptz', ...D(80) },

  // ---- Logitech (its software camera first, or the catch-all would claim it)
  { re: /Logi(tech)? Capture/i, name: 'Logi Capture', kind: 'virtual', note: 'Software camera: the image may be cropped.' },
  { re: /MX Brio/i, name: 'Logitech MX Brio', kind: 'pro', ...D(90) },
  { re: /Brio 50\d/i, name: 'Logitech Brio 500', kind: 'pro', ...D(90) },
  { re: /Brio 30\d/i, name: 'Logitech Brio 300', kind: 'pro', ...D(70) },
  { re: /Brio 10\d/i, name: 'Logitech Brio 100', kind: 'pro', ...D(58) },
  { re: /\bBrio\b|046d:085e/i, name: 'Logitech Brio 4K', kind: 'pro', ...D(90) },
  { re: /StreamCam|046d:0893/i, name: 'Logitech StreamCam', kind: 'pro', ...D(78) },
  { re: /C930|046d:0843/i, name: 'Logitech C930e', kind: 'pro', ...D(90) },
  { re: /C92[025]|C615|HD Pro Webcam|046d:08(2d|e5|5c|5b)/i, name: 'Logitech C920 / C922', kind: 'pro', ...D(78) },
  { re: /C9[89]0|C980/i, name: 'Logitech C980', kind: 'pro', ...D(78) },
  { re: /C50[05]|C31\d|046d:081b/i, name: 'Logitech C505 / C310', kind: 'pro', ...D(60) },
  { re: /C270|046d:0825/i, name: 'Logitech C270', kind: 'pro', ...D(55) },
  { re: /Logi(tech)?|046d:/i, name: 'Logitech webcam', kind: 'pro', ...D(78) },

  // ---- Razer, Elgato, Microsoft, Dell, Anker, AVerMedia, …
  { re: /Kiyo Pro Ultra/i, name: 'Razer Kiyo Pro Ultra', kind: 'pro', ...D(82) },
  { re: /Kiyo Pro/i, name: 'Razer Kiyo Pro', kind: 'pro', ...D(103) },
  { re: /Kiyo X/i, name: 'Razer Kiyo X', kind: 'pro', ...D(82) },
  { re: /Kiyo|1532:/i, name: 'Razer Kiyo', kind: 'pro', ...D(81.6) },
  { re: /Facecam Pro/i, name: 'Elgato Facecam Pro', kind: 'pro', ...D(90) },
  { re: /Facecam MK\.?2/i, name: 'Elgato Facecam MK.2', kind: 'pro', ...D(84) },
  { re: /Facecam/i, name: 'Elgato Facecam', kind: 'pro', ...D(82) },
  { re: /LifeCam Studio/i, name: 'Microsoft LifeCam Studio', kind: 'pro', ...D(75) },
  { re: /LifeCam Cinema/i, name: 'Microsoft LifeCam Cinema', kind: 'pro', ...D(73) },
  { re: /LifeCam/i, name: 'Microsoft LifeCam', kind: 'pro', ...D(68.5) },
  { re: /Microsoft Modern Webcam|Surface.*Camera Front|Front Camera/i, name: 'Microsoft / Surface camera', kind: 'webcam', ...D(78) },
  { re: /UltraSharp.*Webcam|WB7022/i, name: 'Dell UltraSharp Webcam', kind: 'pro', ...D(78) },
  { re: /Dell Pro Webcam|WB5023/i, name: 'Dell Pro Webcam', kind: 'pro', ...D(78) },
  { re: /PowerConf C3\d\d/i, name: 'Anker PowerConf C300', kind: 'pro', ...D(115) },
  { re: /PowerConf C2\d\d/i, name: 'Anker PowerConf C200', kind: 'pro', ...D(95) },
  { re: /AVerMedia.*(PW|Live Streamer CAM)|PW31\d|PW51\d/i, name: 'AVerMedia webcam', kind: 'pro', ...D(94) },
  { re: /Creative Live! ?Cam/i, name: 'Creative Live! Cam', kind: 'pro', ...D(95) },
  { re: /NexiGo/i, name: 'NexiGo webcam', kind: 'pro', ...D(80) },
  { re: /EMEET/i, name: 'EMEET webcam', kind: 'pro', ...D(88) },
  { re: /Lenovo.*(Performance|Essential|FHD) Webcam|Lenovo 300/i, name: 'Lenovo webcam', kind: 'pro', ...D(95) },
  { re: /HP 9[56]\d|HP 4K Streaming|HP.*Webcam/i, name: 'HP webcam', kind: 'pro', ...D(78) },

  // ---- phones as webcams
  { re: /Desk View/i, name: 'iPhone Desk View', kind: 'virtual', note: 'A downward desk shot, not a face camera.' },
  { re: /Continuity|iPhone|iPad/i, name: 'iPhone (Continuity Camera)', kind: 'phone', ...D(78), note: 'Turn Center Stage off in Control Centre for true depth.' },
  { re: /DroidCam|Camo|Iriun|EpocCam|iVCam|e2eSoft|NDI Webcam|Phone Link|Galaxy|Pixel/i, name: 'Phone webcam', kind: 'phone', ...D(78) },

  // ---- capture cards
  { re: /Cam Link|HD60|4K60|Game Capture|Live Gamer|Magewell|USB Capture|Blackmagic|UltraStudio|DeckLink|AJA|USB3\.?0 ?Capture|HDMI|Video Capture|USB Video(?! Device)\b/i, name: 'HDMI capture', kind: 'capture', note: 'The FOV depends on the lens: set it below for true depth.' },

  // ---- virtual cameras
  { re: /OBS|NVIDIA Broadcast|XSplit|Snap Camera|mmhmm|ManyCam|Streamlabs|Logi Capture|vMix|SplitCam|Virtual|VCam|ChromaCam|YouCam|FaceRig|Zoom|Teams/i, name: 'Virtual camera', kind: 'virtual', note: 'Software camera: the image may be cropped or have a replaced background.' },

  // ---- built-in laptop cameras and other webcams
  { re: /FaceTime/i, name: 'FaceTime HD camera', kind: 'webcam', ...D(78) },
  { re: /Wide Vision/i, name: 'HP Wide Vision camera', kind: 'webcam', ...D(88) },
  { re: /Integrated (Camera|Webcam)|HD (User Facing|Camera|Webcam)|Laptop|USB2\.0 (HD )?(UVC )?WebCam|Chicony|Realtek|04f2:|5986:|13d3:|0bda:|0c45:/i, name: 'Built-in camera', kind: 'webcam', ...D(75) },
];

const GENERIC = { name: 'Camera', kind: 'webcam', dfov: 0 };
const DEFAULT_HFOV = 60;

/** The profile for a device label (always returns one). */
export function recognise(label) {
  // Names are matched without Chromium's "(vid:pid)" suffix (so `$` anchors work), ids with it.
  const l = label || '';
  const name = cleanLabel(l);
  for (const p of PROFILES) if (p.re.test(name) || p.re.test(l)) return p;
  return GENERIC;
}

/** Horizontal FOV in degrees for a frame of aspect `aspect` (width/height). */
export function hfovFor(p, aspect = 16 / 9) {
  if (p.hfov) return p.hfov;
  if (p.hfovEye) return p.hfovEye;
  if (!p.dfov) return DEFAULT_HFOV;
  const t = Math.tan((p.dfov * Math.PI) / 360) * (aspect / Math.hypot(aspect, 1));
  return (Math.atan(t) * 360) / Math.PI;
}

/** Label without Chromium's "(vid:pid)" suffix. */
export const cleanLabel = (label) => (label || 'Camera').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');

/** USB "vid:pid" from a Chromium label, or ''. */
export const usbId = (label) => (/\(([0-9a-f]{4}:[0-9a-f]{4})\)\s*$/i.exec(label || '') || [])[1] || '';

export const rankOf = (p) => KINDS[p.kind]?.[1] ?? 0;
export const usable = (p) => rankOf(p) >= 0;

/** The best camera to open by default from a listCameras() array, or null. */
export function bestCamera(cams) {
  let best = null;
  for (const c of cams) {
    const r = rankOf(c.profile);
    if (r < 0) continue;
    if (!best || r > rankOf(best.profile)) best = c;
  }
  return best;
}

// Per-camera FOV overrides the user set in the Camera dialog, kept in this browser only.
const FOV_KEY = 'splat-call.fov';
function fovStore() {
  try {
    return JSON.parse(localStorage.getItem(FOV_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
export function savedFov(label) {
  return Number(fovStore()[cleanLabel(label)]) || 0;
}
export function saveFov(label, deg) {
  try {
    const s = fovStore();
    if (deg) s[cleanLabel(label)] = Math.round(deg * 10) / 10;
    else delete s[cleanLabel(label)];
    localStorage.setItem(FOV_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: the override lasts for this page only */
  }
}
