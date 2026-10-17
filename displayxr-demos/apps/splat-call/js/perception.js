// Perception on the main thread (MediaPipe Tasks, GPU delegate): 478 face landmarks, including
// the irises that give us metric distance, and a person mask from the multiclass selfie
// segmenter (hair, skin, clothes and accessories all count as the person).

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

export class Perception {
  async init() {
    const { FilesetResolver, FaceLandmarker, ImageSegmenter } = await import(`${MP}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const make = async (delegate) => Promise.all([
      FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minTrackingConfidence: 0.4,
        // Head pose and expression, for the 3D avatars (looks.js).
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }),
      ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: SEG_MODEL, delegate },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      }),
    ]);
    try {
      [this.face, this.seg] = await make('GPU');
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('[perception] GPU delegate failed, using CPU', e);
      [this.face, this.seg] = await make('CPU');
      this.delegate = 'CPU';
    }
    this.lastTs = 0;
  }

  /**
   * Run both models on the current video frame.
   * @returns {{ lm: Float32Array|null, mask: Float32Array, mw: number, mh: number,
   *            pose: number[]|null, blend: Record<string, number>|null }}
   */
  detect(source) {
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 0.01;
    this.lastTs = ts;

    let lm = null;
    const fr = this.face.detectForVideo(source, ts);
    const pts = fr.faceLandmarks?.[0];
    if (pts && pts.length >= 478) {
      lm = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        lm[i * 3] = pts[i].x;
        lm[i * 3 + 1] = pts[i].y;
        lm[i * 3 + 2] = pts[i].z;
      }
    }
    const pose = fr.facialTransformationMatrixes?.[0]?.data ? Array.from(fr.facialTransformationMatrixes[0].data) : null;
    let blend = null;
    const cats = fr.faceBlendshapes?.[0]?.categories;
    if (cats) {
      blend = {};
      for (const c of cats) blend[c.categoryName] = c.score;
    }

    let mask = null, mw = 0, mh = 0;
    this.seg.segmentForVideo(source, ts, (res) => {
      // Masks are only valid inside this callback. Class 0 is background.
      const bg = res.confidenceMasks?.[0];
      if (!bg) return;
      mw = bg.width;
      mh = bg.height;
      const a = bg.getAsFloat32Array();
      mask = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) mask[i] = 1 - a[i];
      for (const m of res.confidenceMasks) m.close();
    });
    return { lm, mask, mw, mh, pose, blend };
  }
}
