// cameras.js — stereo cameras the SDK's own detection does not catch.
//
// `openCamera({ prefer: 'stereo' })` recognises the DisplayXR Browser's "3D Camera" and any
// device sending frames wider than 2.5:1 (a full side-by-side pair). A camera that sends HALF
// side-by-side — two eyes squeezed into one 16:9 frame, like the Acer SpatialLabs Eyes in webcam
// mode — looks like an ordinary webcam by shape, so it is recognised here by its label and
// opened with its own constraints; the stream is then handed to `openCamera` as a declared pair.

/**
 * @typedef {{ name: string, layout: 'sbs' | 'half-sbs', eyeAspect: number, baselineMm: number,
 *             hfovDeg: number, width: number, height: number, frameRate: number }} StereoProfile
 */

/** @type {Array<{ match: RegExp } & StereoProfile>} */
export const KNOWN_STEREO_CAMERAS = [
  {
    // Acer SpatialLabs Eyes (ASEC-1): stereo webcam mode 3840×2160 SBS (two 16:9 eyes squeezed
    // to 1920×2160 each), 63 mm lens spacing, 3 mm lenses ≈ 21 mm full-frame equivalent.
    match: /spatial\s*labs|spatial\s*eyes|asec-?1/i,
    name: 'Acer SpatialLabs Eyes',
    layout: 'half-sbs',
    eyeAspect: 16 / 9,
    baselineMm: 63,
    hfovDeg: 82,
    width: 3840,
    height: 2160,
    frameRate: 30,
  },
];

/** The known profile for a device label, or null. */
export function knownStereoCamera(label) {
  return (label && KNOWN_STEREO_CAMERAS.find((c) => c.match.test(label))) || null;
}

/** Labels that suggest a stereo camera we have no profile for (offered, never assumed). */
export const STEREO_HINT = /\b(3d|stereo|sbs|side[- ]by[- ]side|dual)\b/i;

/**
 * The per-eye aspect of a side-by-side frame. `layout` 'sbs' halves the frame; 'half-sbs' keeps
 * the frame's aspect for each eye (each was squeezed to half width); 'auto' picks by shape: wider
 * than 2.5:1 is a full pair, anything narrower a half pair.
 */
export function eyeAspectOf(frameW, frameH, layout = 'auto') {
  const a = frameW / frameH;
  if (layout === 'sbs') return a / 2;
  if (layout === 'half-sbs') return a;
  return a > 2.5 ? a / 2 : a;
}

/** Open a device as a side-by-side pair with the profile's resolution. */
export async function openProfileStream(deviceId, p) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: p.width },
      height: { ideal: p.height },
      frameRate: { ideal: p.frameRate },
    },
  });
}
